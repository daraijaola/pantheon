import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const [command, moduleRoot, source, destination] = process.argv.slice(2);
if (!["backup", "check"].includes(command) || !moduleRoot || !source || (command === "backup" && !destination)) {
  console.error("usage: backup-sqlite.mjs backup|check MODULE_ROOT SOURCE [DESTINATION]");
  process.exit(2);
}

const require = createRequire(resolve(moduleRoot, "package.json"));
const Database = require("better-sqlite3");

if (command === "backup") {
  await mkdir(dirname(resolve(destination)), { recursive: true });
  const database = new Database(resolve(source), { readonly: true, fileMustExist: true });
  try {
    await database.backup(resolve(destination));
  } finally {
    database.close();
  }
}

const checked = new Database(resolve(command === "backup" ? destination : source), { readonly: true, fileMustExist: true });
try {
  const rows = checked.pragma("quick_check");
  if (rows.length !== 1 || rows[0].quick_check !== "ok") throw new Error(`SQLite quick_check failed: ${JSON.stringify(rows)}`);
} finally {
  checked.close();
}
