import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { operations } from "../src/server/catalog";
import { createOpenApi } from "../src/server/openapi";

const record = z.record(z.string(), z.unknown());
const source = record.parse(
  await Bun.file(new URL("../codex-contract-atlas/snapshot/openapi.json", import.meta.url)).json(),
);
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

function walk(value: unknown, visit: (entry: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value !== null && typeof value === "object") {
    const entry = record.parse(value);
    visit(entry);
    for (const item of Object.values(entry)) walk(item, visit);
  }
}

describe("same-origin OpenAPI reference", () => {
  test("retains every public schema when the local reference is generated", async () => {
    // Given the full public source, including fields outside the proxy adapter.
    const sourceComponents = record.parse(source["components"]);
    // When the local reference is generated.
    const spec = await createOpenApi("test-default-model");
    // Then the complete schemas and reusable responses remain literal.
    const components = record.parse(spec["components"]);
    expect(components["schemas"]).toEqual(sourceComponents["schemas"]);
    expect(components["responses"]).toEqual(sourceComponents["responses"]);
    expect(spec["openapi"]).toBe("3.1.0");
  });

  test("resolves every local reference when all schema branches are explored", async () => {
    // Given a generated document.
    const spec = await createOpenApi("test-default-model");
    const missing: string[] = [];
    // When each JSON pointer is resolved against that document.
    walk(spec, (entry) => {
      const ref = entry["$ref"];
      if (typeof ref !== "string") return;
      expect(ref.startsWith("#/")).toBe(true);
      let target: unknown = spec;
      for (const segment of ref.slice(2).split("/")) {
        const parsed = record.safeParse(target);
        target = parsed.success
          ? parsed.data[segment.replaceAll("~1", "/").replaceAll("~0", "~")]
          : undefined;
      }
      if (target === undefined) missing.push(ref);
    });
    // Then no preserved schema references an omitted component.
    expect(missing).toEqual([]);
  });

  test("covers all selected source operations when beta aliases are excluded", async () => {
    // Given every non-beta source path in the exposed families.
    const expected = Object.entries(record.parse(source["paths"]))
      .filter(
        ([path]) =>
          /^\/(responses|models|images|audio|realtime|live)(\/|$)/.test(path) &&
          !path.includes("?"),
      )
      .flatMap(([path, value]) =>
        Object.keys(record.parse(value))
          .filter((method) => methods.has(method))
          .map((method) => `${method} /v1${path}`),
      );
    // When the catalogue is projected to route keys.
    const actual = operations.map(
      (operation) => `${operation.method.toLowerCase()} ${operation.path}`,
    );
    // Then all 38 source operations are available in the explorer.
    expect(expected).toHaveLength(38);
    for (const route of expected) expect(actual).toContain(route);
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual.every((route) => !route.includes("?"))).toBe(true);
  });

  test("matches catalogue routes and unique IDs when building the API explorer", async () => {
    // Given the exported catalogue.
    const expected = operations
      .map((operation) => `${operation.method.toLowerCase()} ${operation.path}`)
      .sort();
    // When the OpenAPI operation set is read.
    const spec = await createOpenApi("test-default-model");
    const ids: string[] = [];
    const actual = Object.entries(record.parse(spec["paths"])).flatMap(([path, value]) =>
      Object.entries(record.parse(value))
        .filter(([method]) => methods.has(method))
        .map(([method, value]) => {
          const operation = record.parse(value);
          ids.push(z.string().parse(operation["operationId"]));
          return `${method} ${path}`;
        }),
    );
    // Then the API and control routes each have a unique operation ID.
    expect(actual.filter((route) => route.includes(" /v1/")).sort()).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("keeps requests local when the reference provides runnable operations", async () => {
    // Given a local server without any Codex credential in its documentation.
    const spec = await createOpenApi("test-default-model");
    const servers: unknown[] = [];
    // When runnable server declarations are collected.
    walk(spec, (entry) => {
      if (entry["servers"] !== undefined) servers.push(entry["servers"]);
      expect(entry["proxyUrl"]).toBeUndefined();
    });
    // Then all requests target the same origin and use only the local token.
    expect(servers).toEqual([[{ url: "/" }]]);
    expect(spec["security"]).toEqual([{ LocalBearer: [] }]);
    const schemes = record.parse(record.parse(spec["components"])["securitySchemes"]);
    expect(Object.keys(schemes)).toEqual(["LocalBearer"]);
    expect(record.parse(schemes["LocalBearer"])["scheme"]).toBe("bearer");
    for (const item of Object.values(record.parse(spec["paths"]))) {
      for (const [method, operation] of Object.entries(record.parse(item))) {
        if (!methods.has(method)) continue;
        const detail = record.parse(operation);
        expect(detail["security"]).toEqual(
          detail["operationId"] === "getHealth" ? [] : [{ LocalBearer: [] }],
        );
      }
    }
  });

  test("keeps request schemas intact when adding a runnable Responses example", async () => {
    // Given a configured model different from the public source examples.
    const sourcePost = record.parse(
      record.parse(record.parse(source["paths"])["/responses"])["post"],
    );
    // When the reference supplies its local request example.
    const spec = await createOpenApi("configured-model");
    const post = record.parse(record.parse(record.parse(spec["paths"])["/v1/responses"])["post"]);
    const body = record.parse(post["requestBody"]);
    const json = record.parse(record.parse(body["content"])["application/json"]);
    const original = record.parse(
      record.parse(record.parse(sourcePost["requestBody"])["content"])["application/json"],
    );
    // Then the source schema survives and the example reflects local adaptation.
    expect(json["schema"]).toEqual(original["schema"]);
    expect(json["example"]).toEqual({
      model: "configured-model",
      input: "Say hello in one sentence.",
      store: false,
      stream: true,
    });
    expect(post["responses"]).toEqual(sourcePost["responses"]);
    expect(post["x-proxy-availability"]).toBe("verified");
  });

  test("separates route support from upstream proof when exposing capability metadata", () => {
    // Given the public operation catalogue.
    // When its evidence levels are inspected.
    const verified = operations.filter((operation) => operation.availability === "verified");
    // Then only the direct Responses flow claims runtime proof.
    expect(verified.map((operation) => `${operation.method} ${operation.path}`)).toEqual([
      "POST /v1/responses",
    ]);
    expect(
      operations.find((operation) => operation.path === "/v1/audio/speech")?.availability,
    ).toBe("unverified");
    expect(operations.find((operation) => operation.id === "listModels")?.availability).toBe(
      "source-backed",
    );
    expect(
      operations
        .filter((operation) => operation.method !== "GET" || operation.path !== "/v1/responses")
        .every((operation) => operation.supported),
    ).toBe(true);
  });
});
