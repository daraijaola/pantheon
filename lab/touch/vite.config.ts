import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// Dev-only endpoint: the lab POSTs baked frames here and they land in ./out.
export default defineConfig({
  server: { port: 5199, strictPort: true },
  plugins: [
    react(),
    {
      name: "lab-save",
      configureServer(server) {
        server.middlewares.use("/__save", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end();
            return;
          }
          const name = path.basename(new URL(req.url ?? "", "http://lab").searchParams.get("name") ?? "out.json");
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            const file = path.join(root, "out", name);
            fs.writeFileSync(file, Buffer.concat(chunks));
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, file, bytes: fs.statSync(file).size }));
          });
        });
      },
    },
  ],
});
