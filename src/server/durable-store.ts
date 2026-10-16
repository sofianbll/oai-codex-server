import { Database } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { GatewayError } from "../shared/contracts";

const APPLICATION_ID = 0x4f414943;
const GLOBAL_BYTES = 1024 * 1024 * 1024;
const OBJECT_BYTES = 4 * 1024 * 1024;

export type DurableStoreOptions = {
  readonly path?: string;
  readonly maxBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxRecords?: number;
  readonly now?: () => number;
};

/** One budget for every account and retained content kind. No live row is evicted. */
export function createDurableStore(options: DurableStoreOptions = {}) {
  const path = options.path ?? ":memory:";
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0)
      throw new Error("Durable storage requires a private directory (0700)");
    if (existsSync(path)) {
      const file = lstatSync(path);
      if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) !== 0)
        throw new Error("Durable storage requires a private regular file (0600)");
    } else closeSync(openSync(path, "wx", 0o600));
  }
  const db = new Database(path, { strict: true });
  try {
    const identity = db.query<{ application_id: number }, []>("PRAGMA application_id").get();
    const tables = db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master")
      .get();
    if (
      identity?.application_id !== APPLICATION_ID &&
      ((tables?.count ?? 0) !== 0 || identity?.application_id !== 0)
    )
      throw new Error("Refusing to migrate or reuse a foreign database");
    // DELETE journal cannot accumulate across commits; pages bound its in-flight size too.
    db.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=294912;
      PRAGMA journal_mode=DELETE; PRAGMA journal_size_limit=0; PRAGMA synchronous=FULL;
      PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA busy_timeout=1000;
      PRAGMA application_id=${APPLICATION_ID};
      CREATE TABLE IF NOT EXISTS durable_objects (
        account TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
        payload TEXT NOT NULL, bytes INTEGER NOT NULL, expires INTEGER,
        PRIMARY KEY(account, kind, id)
      );
      CREATE INDEX IF NOT EXISTS durable_expiry ON durable_objects(expires);
      CREATE TABLE IF NOT EXISTS durable_reservations (
        token TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL,
        bytes INTEGER NOT NULL, expires INTEGER NOT NULL
      );`);
  } catch (error) {
    db.close();
    throw error;
  }
  const now = options.now ?? Date.now;
  const maxBytes = Math.min(options.maxBytes ?? GLOBAL_BYTES, GLOBAL_BYTES);
  const maxRecordBytes = Math.min(options.maxRecordBytes ?? OBJECT_BYTES, OBJECT_BYTES, maxBytes);
  const maxRecords = options.maxRecords ?? 65536;
  const ownedReservations = new Set<string>();
  let closed = false;
  const prune = () => {
    db.query("DELETE FROM durable_objects WHERE expires <= ?").run(now());
    db.query("DELETE FROM durable_reservations WHERE expires <= ?").run(now());
  };
  const capacityError = () =>
    new GatewayError(
      507,
      "storage_capacity_exceeded",
      "Local durable storage capacity is unavailable; no retained object was evicted",
    );
  const transaction = <T>(operation: () => T): T => {
    try {
      return db.transaction(operation).immediate();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "SQLITE_FULL")
        throw capacityError();
      if (
        error instanceof Error &&
        "code" in error &&
        ["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_IOERR"].includes(String(error.code))
      )
        throw new GatewayError(
          503,
          "storage_unavailable",
          "Local durable storage could not complete the transaction",
        );
      throw error;
    }
  };
  const store = {
    maxRecordBytes,
    reserve(account: string, kind: string, durationMs: number, allocation = maxRecordBytes) {
      if (!Number.isSafeInteger(allocation) || allocation <= 0 || allocation > maxRecordBytes)
        throw capacityError();
      const token = crypto.randomUUID();
      transaction(() => {
        prune();
        const used = db
          .query<{ bytes: number }, []>(`SELECT
          (SELECT coalesce(sum(bytes),0) FROM durable_objects) +
          (SELECT coalesce(sum(bytes),0) FROM durable_reservations) AS bytes`)
          .get();
        const count = db
          .query<{ count: number }, []>(`SELECT
          (SELECT count(*) FROM durable_objects) +
          (SELECT count(*) FROM durable_reservations) AS count`)
          .get();
        if ((used?.bytes ?? 0) + allocation > maxBytes || (count?.count ?? 0) >= maxRecords)
          throw capacityError();
        db.query("INSERT INTO durable_reservations VALUES (?, ?, ?, ?, ?)").run(
          token,
          account,
          kind,
          allocation,
          now() + durationMs,
        );
      });
      ownedReservations.add(token);
      let released = false;
      return {
        commit(id: string, payload: unknown, expires: number | null) {
          if (closed)
            throw new GatewayError(503, "storage_unavailable", "Local durable storage was closed");
          const serialized = JSON.stringify(payload);
          const bytes = Buffer.byteLength(JSON.stringify([account, kind, id, serialized, expires]));
          if (bytes > allocation)
            throw new GatewayError(
              507,
              "stored_response_too_large",
              "Response and inputs exceed the per-object durable storage limit",
            );
          transaction(() => {
            // Checked in the same write transaction as replacement and quota accounting.
            const valid = db
              .query("SELECT token FROM durable_reservations WHERE token=? AND expires>?")
              .get(token, now());
            if (released || !valid) throw capacityError();
            db.query(
              "INSERT INTO durable_objects VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account,kind,id) DO UPDATE SET payload=excluded.payload, bytes=excluded.bytes, expires=excluded.expires",
            ).run(account, kind, id, serialized, bytes, expires);
            db.query("DELETE FROM durable_reservations WHERE token=?").run(token);
          });
          ownedReservations.delete(token);
          released = true;
        },
        release() {
          if (released || closed) return;
          db.query("DELETE FROM durable_reservations WHERE token=?").run(token);
          released = true;
          ownedReservations.delete(token);
        },
      };
    },
    /** Synchronous read/modify/write, serialized across store instances by SQLite. */
    atomic<T>(operation: () => T): T {
      return transaction(operation);
    },
    /** Exact-size reservation for already available content, under the same global budget. */
    put(
      account: string,
      kind: string,
      id: string,
      payload: unknown,
      expires: number | null = null,
    ) {
      const bytes = Buffer.byteLength(
        JSON.stringify([account, kind, id, JSON.stringify(payload), expires]),
      );
      const reservation = store.reserve(account, kind, 60000, bytes);
      try {
        reservation.commit(id, payload, expires);
      } finally {
        reservation.release();
      }
    },
    list(
      account: string,
      kind: string,
      order: "asc" | "desc",
      limit: number,
      after?: string,
    ): { id: string; payload: unknown }[] {
      const cursor =
        after === undefined
          ? undefined
          : db
              .query<{ rowid: number }, [string, string, string, number]>(
                "SELECT rowid FROM durable_objects WHERE account=? AND kind=? AND id=? AND (expires IS NULL OR expires>?)",
              )
              .get(account, kind, after, now());
      if (after !== undefined && !cursor)
        throw new GatewayError(400, "invalid_cursor", "Cursor does not belong to this collection");
      const rows = db
        .query<{ id: string; payload: string }, [string, string, number, number, number]>(
          `SELECT id,payload FROM durable_objects WHERE account=? AND kind=? AND (expires IS NULL OR expires>?) AND rowid ${order === "asc" ? ">" : "<"} ? ORDER BY rowid ${order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
        )
        .all(
          account,
          kind,
          now(),
          cursor?.rowid ?? (order === "asc" ? 0 : Number.MAX_SAFE_INTEGER),
          limit,
        );
      return rows.map((row) => ({ id: row.id, payload: JSON.parse(row.payload) as unknown }));
    },
    get(account: string, kind: string, id: string): unknown {
      const row = db
        .query<{ payload: string }, [string, string, string, number]>(
          "SELECT payload FROM durable_objects WHERE account=? AND kind=? AND id=? AND (expires IS NULL OR expires>?)",
        )
        .get(account, kind, id, now());
      return row ? JSON.parse(row.payload) : undefined;
    },
    delete(account: string, kind: string, id: string): boolean {
      return (
        db
          .query(
            "DELETE FROM durable_objects WHERE account=? AND kind=? AND id=? AND (expires IS NULL OR expires>?)",
          )
          .run(account, kind, id, now()).changes > 0
      );
    },
    size() {
      return (
        db
          .query<{ count: number }, [number]>(
            "SELECT count(*) AS count FROM durable_objects WHERE expires IS NULL OR expires>?",
          )
          .get(now())?.count ?? 0
      );
    },
    close() {
      if (closed) return;
      transaction(() => {
        for (const token of ownedReservations)
          db.query("DELETE FROM durable_reservations WHERE token=?").run(token);
      });
      ownedReservations.clear();
      closed = true;
      db.close();
    },
  };
  return store;
}

export type DurableStore = ReturnType<typeof createDurableStore>;
