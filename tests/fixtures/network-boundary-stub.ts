// Loaded before the configured guard in a child process: no stub ever calls a native transport.
export const fetchCalls: unknown[][] = [];
export const preconnectCalls: unknown[][] = [];
export const socketCalls: unknown[][] = [];

const stubFetch = Object.assign(globalThis.fetch.bind(globalThis), globalThis.fetch, {
  preconnect: (...args: unknown[]) => {
    preconnectCalls.push(args);
  },
});
globalThis.fetch = new Proxy(stubFetch, {
  apply(_target, _receiver, args) {
    fetchCalls.push(args);
    return Promise.resolve(new Response("boundary stub"));
  },
});
globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
  construct(target, args) {
    socketCalls.push(args);
    return Object.create(target.prototype);
  },
});
export const boundaryFetch = globalThis.fetch;
export const BoundaryWebSocket = globalThis.WebSocket;
