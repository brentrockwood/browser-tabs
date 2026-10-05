// Minimal Chrome DevTools Protocol client built on Node's native WebSocket
// client (global `WebSocket`, stable without a flag since Node.js 22 — this
// is a smoke-test-only requirement, not a project-wide one; see README).
// No hand-written RFC 6455 framing:
// Node's WebSocket implementation owns the wire protocol; this module only
// adds CDP's request/response correlation, per-command timeouts, rejection
// of in-flight commands if the socket errors or closes, and dispatch of
// unsolicited CDP events (messages with no `id`, e.g. `Runtime.
// consoleAPICalled`) to subscribers — needed for test diagnostics such as
// capturing a service worker's console output.

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export function connectCdp(webSocketDebuggerUrl, { commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    let nextId = 1;
    let settled = false;
    const pending = new Map();
    const eventListeners = new Map(); // CDP method name -> Set<handler>

    function rejectPending(error) {
      for (const { reject: rejectCommand, timer } of pending.values()) {
        clearTimeout(timer);
        rejectCommand(error);
      }
      pending.clear();
    }

    socket.addEventListener("open", () => {
      settled = true;
      resolve(client);
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.id === undefined) {
        // An unsolicited CDP event, e.g. {method, params} with no id.
        const handlers = eventListeners.get(message.method);
        if (handlers) for (const handler of handlers) handler(message.params);
        return;
      }

      if (!pending.has(message.id)) return;
      const { resolve: resolveCommand, reject: rejectCommand, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) rejectCommand(new Error(message.error.message));
      else resolveCommand(message.result);
    });

    socket.addEventListener("error", () => {
      const error = new Error(`CDP WebSocket error connecting to ${webSocketDebuggerUrl}`);
      if (!settled) {
        settled = true;
        reject(error);
      }
      rejectPending(error);
    });

    socket.addEventListener("close", () => {
      const error = new Error(`CDP WebSocket closed: ${webSocketDebuggerUrl}`);
      if (!settled) {
        settled = true;
        reject(error);
      }
      rejectPending(error);
    });

    const client = {
      send(method, params = {}) {
        if (socket.readyState !== WebSocket.OPEN) {
          return Promise.reject(new Error(`Cannot send CDP command "${method}": socket is not open`));
        }
        return new Promise((resolveCommand, rejectCommand) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectCommand(new Error(`CDP command "${method}" timed out after ${commandTimeoutMs}ms`));
          }, commandTimeoutMs);
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      // Subscribes to an unsolicited CDP event (e.g. "Runtime.
      // consoleAPICalled"). Returns an unsubscribe function. The relevant
      // domain must already be enabled (e.g. `send("Runtime.enable")`) for
      // Chrome to emit the event at all.
      on(method, handler) {
        if (!eventListeners.has(method)) eventListeners.set(method, new Set());
        eventListeners.get(method).add(handler);
        return () => eventListeners.get(method)?.delete(handler);
      },
      close() {
        socket.close();
      },
    };
  });
}
