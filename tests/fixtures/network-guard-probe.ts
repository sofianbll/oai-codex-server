import { expect, test } from "bun:test";
import {
  BoundaryWebSocket,
  boundaryFetch,
  fetchCalls,
  preconnectCalls,
  socketCalls,
} from "./network-boundary-stub";

test("remote string, URL and Request destinations never reach the external HTTP/WS stubs", async () => {
  const blocked = /Test network guard/;
  for (const input of [
    "https://network.invalid/never-send",
    new URL("http://network.invalid/never-send"),
    new Request("https://network.invalid/never-send", { method: "POST", body: "synthetic" }),
    "http://localhost.network.invalid/never-send",
    "http://127.0.0.1@network.invalid/never-send",
  ]) {
    await expect(Promise.resolve().then(() => fetch(input))).rejects.toThrow(blocked);
  }
  for (const input of [
    "ws://network.invalid/never-send",
    new URL("wss://network.invalid/never-send"),
  ])
    expect(() => new WebSocket(input)).toThrow(blocked);
  expect(() => fetch.preconnect("https://network.invalid/never-connect")).toThrow(blocked);
  expect({
    fetch: fetchCalls.length,
    socket: socketCalls.length,
    preconnect: preconnectCalls.length,
  }).toEqual({ fetch: 0, socket: 0, preconnect: 0 });
});

test("loopback calls preserve overload arguments, WebSocket statics and instanceof", async () => {
  fetchCalls.length = socketCalls.length = preconnectCalls.length = 0;
  const request = new Request("https://localhost/example", { method: "POST", body: "local" });
  expect(await (await fetch("http://127.0.0.1/example")).text()).toBe("boundary stub");
  await fetch(new URL("http://[::1]/example"));
  await fetch(request, { headers: { "x-fixture": "preserved" }, redirect: "manual" });
  expect(fetchCalls[2]).toEqual([
    request,
    { headers: { "x-fixture": "preserved" }, redirect: "manual" },
  ]);
  expect(fetchCalls[0]?.[1]).toMatchObject({ redirect: "error" });
  fetch.preconnect(new URL("https://localhost/example"), { dns: true });
  expect(preconnectCalls).toEqual([[new URL("https://localhost/example"), { dns: true }]]);
  expect(typeof fetch.preconnect).toBe(typeof boundaryFetch.preconnect);
  const options = { headers: { "x-fixture": "preserved" } };
  const socket = new WebSocket("ws://127.0.0.1/example", ["fixture"]);
  new WebSocket(new URL("wss://localhost/example"), options);
  new WebSocket("ws://[::1]/example", "fixture");
  expect(socketCalls).toEqual([
    ["ws://127.0.0.1/example", ["fixture"]],
    [new URL("wss://localhost/example"), options],
    ["ws://[::1]/example", "fixture"],
  ]);
  expect(socket instanceof WebSocket).toBe(true);
  expect(socket instanceof BoundaryWebSocket).toBe(true);
  expect(WebSocket.prototype).toBe(BoundaryWebSocket.prototype);
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const)
    expect(WebSocket[key]).toBe(BoundaryWebSocket[key]);
});
