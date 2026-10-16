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
  const reserve = (
    account: string,
    kind: string,
    durationMs: number,
    replacingId?: string,
    capacityBytes = maxRecordBytes,
  ) => {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 0 || capacityBytes > maxRecordBytes)
      throw capacityError();
    const token = crypto.randomUUID();
    transaction(() => {
      prune();
      const replaced =
        replacingId === undefined
          ? 0
          : (db
              .query<{ bytes: number }, [string, string, string]>(
                "SELECT bytes FROM durable_objects WHERE account=? AND kind=? AND id=?",
              )
              .get(account, kind, replacingId)?.bytes ?? 0);
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
      if (
        (used?.bytes ?? 0) + Math.max(0, capacityBytes - replaced) > maxBytes ||
        (count?.count ?? 0) + (replaced > 0 ? 0 : 1) > maxRecords
      )
        throw capacityError();
      db.query("INSERT INTO durable_reservations VALUES (?, ?, ?, ?, ?)").run(
        token,
        account,
        kind,
        Math.max(0, capacityBytes - replaced),
        now() + durationMs,
      );
    });
    ownedReservations.add(token);
    let released = false;
    let checkpointId: string | undefined;
    return {
      commit(id: string, payload: unknown, expires: number | null, checkpoint = false) {
        if (closed)
          throw new GatewayError(503, "storage_unavailable", "Local durable storage was closed");
        const serialized = JSON.stringify(payload);
        if (checkpointId !== undefined && checkpointId !== id)
          throw new GatewayError(
            409,
            "reservation_conflict",
            "A checkpoint reservation belongs to one object",
          );
        const bytes = Buffer.byteLength(JSON.stringify([account, kind, id, serialized, expires]));
        if (bytes > capacityBytes)
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
          if (checkpoint)
            db.query("UPDATE durable_reservations SET bytes=? WHERE token=?").run(
              capacityBytes - bytes,
              token,
            );
          else db.query("DELETE FROM durable_reservations WHERE token=?").run(token);
        });
        if (!checkpoint) {
          ownedReservations.delete(token);
          released = true;
        } else checkpointId = id;
      },
      release() {
        if (released || closed) return;
        db.query("DELETE FROM durable_reservations WHERE token=?").run(token);
        released = true;
        ownedReservations.delete(token);
      },
    };
  };
  return {
    maxRecordBytes,
    reserve: (account: string, kind: string, durationMs: number) =>
      reserve(account, kind, durationMs),
    get(account: string, kind: string, id: string): unknown {
      const row = db
        .query<{ payload: string }, [string, string, string, number]>(
          "SELECT payload FROM durable_objects WHERE account=? AND kind=? AND id=? AND (expires IS NULL OR expires>?)",
        )
        .get(account, kind, id, now());
      return row ? JSON.parse(row.payload) : undefined;
    },
    // One record per read keeps startup recovery bounded independently of database size.
    next(kind: string, after: readonly [string, string] = ["", ""]) {
      const row = db
        .query<{ account: string; id: string; payload: string }, [string, string, string, number]>(
          "SELECT account,id,payload FROM durable_objects WHERE kind=? AND (account,id)>(?,?) AND (expires IS NULL OR expires>?) ORDER BY account,id LIMIT 1",
        )
        .get(kind, after[0], after[1], now());
      return row
        ? { account: row.account, id: row.id, payload: JSON.parse(row.payload) as unknown }
        : undefined;
    },
    /** Exclusive startup recovery: discard orphan producers, never execute retained work. */
    recover(
      kind: string,
      rewrite: (payload: unknown) => { payload: unknown; expires: number | null } | undefined,
    ) {
      transaction(() => {
        db.query("DELETE FROM durable_reservations WHERE kind=?").run(kind);
      });
      let cursor: readonly [string, string] | undefined;
      for (;;) {
        const row = this.next(kind, cursor);
        if (!row) break;
        cursor = [row.account, row.id];
        const changed = rewrite(row.payload);
        if (!changed) continue;
        transaction(() => {
          const bytes = Buffer.byteLength(
            JSON.stringify([
              row.account,
              kind,
              row.id,
              JSON.stringify(changed.payload),
              changed.expires,
            ]),
          );
          const reservation = reserve(row.account, kind, 60_000, row.id, bytes);
          try {
            reservation.commit(row.id, changed.payload, changed.expires);
          } finally {
            reservation.release();
          }
        });
      }
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
}

export type DurableStore = ReturnType<typeof createDurableStore>;
