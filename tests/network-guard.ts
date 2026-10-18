// Test-only URL guard, not an OS firewall or a sandbox for subprocesses/other networking APIs.
function loopback(input: string | URL | Request): void {
  const url = new URL(input instanceof Request ? input.url : input);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Test network guard: only loopback HTTP/WebSocket destinations are allowed");
}

const preconnect = new Proxy(fetch.preconnect, {
  apply(target, receiver, args) {
    loopback(args[0]);
    return Reflect.apply(target, receiver, args);
  },
});
// Bun's native preconnect property is immutable; a bound function can carry its guarded static.
const guardedFetch = Object.assign(globalThis.fetch.bind(globalThis), globalThis.fetch, {
  preconnect,
});
globalThis.fetch = new Proxy(guardedFetch, {
  apply(target, receiver, args) {
    loopback(args[0]);
    const redirect =
      args[1]?.redirect ?? (args[0] instanceof Request ? args[0].redirect : undefined);
    // Native automatic redirects would bypass this URL check; callers can inspect redirects manually.
    return Reflect.apply(target, receiver, [
      args[0],
      { ...args[1], redirect: redirect === "manual" ? "manual" : "error" },
    ]);
  },
});
globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
  construct(target, args, newTarget) {
    loopback(args[0]);
    return Reflect.construct(target, args, newTarget);
  },
});
