// The Forge BullMQ worker runs under plain Node/tsx rather than the Next.js
// compiler/runtime. Next's `server-only` package is useful as a guard in app
// bundles, but its published runtime intentionally throws when imported outside
// that compiler context. Server-side worker modules share the same server code,
// so preload this tiny shim for worker processes only.
const Module = require("node:module");
const originalLoad = Module._load;

Module._load = function forgeWorkerLoad(request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.apply(this, arguments);
};
