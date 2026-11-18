import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let starting = null;

const plugin = {
  id: "magpie-s3-trace-sync",
  server: async (_input, options) => {
    if (!starting) {
      const n = Number(options?.port);
      const port = Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
      starting = import(pathToFileURL(path.join(here, "server.mjs")).href)
        .then((m) =>
          m.startServer({
            port,
            pluginOptions: options ?? {},
          })
        )
        .then((boundPort) => ({ ok: true, port: boundPort }))
        .catch((err) => {
          starting = null;
          console.error("[s3-trace-sync] dashboard service failed to start:", err?.message || err);
          throw err;
        });
    }
    return await starting;
  },
};

export default plugin;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  plugin.server().catch((err) => {
    console.error(`[s3-trace-sync] failed to start: ${err?.message || err}`);
    process.exit(1);
  });
}
