import { backendEnv, configured } from "../../network.mts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishScan } from "../src/live/publish.ts";
import { FeedStore } from "../src/live/store.ts";

Object.assign(process.env, backendEnv(process.env, "feed"));

configured(process.env, "feed", {});
const scan = JSON.parse(readFileSync(join(process.env.OUT_DIR || "out", "scan.json"), "utf8")) as unknown;
const store = new FeedStore(process.env.FEED_DB || "data/feed.db");
try {
  const result = publishScan(scan, store, process.env.FEED_SITE_URL);
  console.log(JSON.stringify(result));
  if (result.skipped) process.exitCode = 1;
} finally {
  store.close();
}
