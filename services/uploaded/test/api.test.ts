// The server, called directly with no network.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp, PER_MINUTE } from "../src/api.ts";
import { Verdicts } from "../src/verdicts.ts";

const FIXTURE = new URL("./fixtures/scan.json", import.meta.url).pathname;
const SCANNED = Date.parse(JSON.parse(readFileSync(FIXTURE, "utf8")).generatedAt);

function ready(now = () => SCANNED) {
  const v = new Verdicts(FIXTURE, { now });
  v.refresh();
  return v;
}

describe("the health check", () => {
  it("says it's ready, with how many coins it knows and how fresh they are", async () => {
    const res = await buildApp(ready()).inject({ url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ ok: true, coins: 7, network: "testnet", scannedAt: JSON.parse(readFileSync(FIXTURE, "utf8")).generatedAt, stale: false, reading: "ok" });
  });

  it("answers 503 until it has verdicts", async () => {
    const res = await buildApp(new Verdicts("/nowhere/scan.json")).inject({ url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, coins: 0 });
  });

  it("stays up on the last good copy when the file breaks, and never shows the file's path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uploaded-"));
    try {
      const file = join(dir, "scan.json");
      writeFileSync(file, readFileSync(FIXTURE));
      const v = new Verdicts(file);
      v.refresh();
      rmSync(file);
      v.refresh();
      expect(v.health().lastError).toContain(dir); // the log needs it
      const res = await buildApp(v).inject({ url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, coins: 7, reading: "failing" });
      expect(res.body).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("everything else", () => {
  it("answers JSON for an unknown address", async () => {
    const res = await buildApp(ready()).inject({ url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("is read-only: a POST goes nowhere", async () => {
    const res = await buildApp(ready()).inject({ method: "POST", url: "/health", payload: { a: 1 } });
    expect(res.statusCode).toBe(404);
  });

  it("doesn't leak what went wrong inside", async () => {
    const broken = {
      health: () => {
        throw new Error("secret detail /home/ayinde");
      },
    };
    const res = await buildApp(broken).inject({ url: "/health" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "INTERNAL" });
  });

  it("slows down a flood, one visitor at a time, and lets them back after a minute", async () => {
    let t = 1_000;
    const app = buildApp(ready(), { now: () => t });
    for (let i = 0; i < PER_MINUTE; i++) expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    const blocked = await app.inject({ url: "/health" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "RATE_LIMITED" });
    expect((await app.inject({ url: "/health", remoteAddress: "10.0.0.2" })).statusCode).toBe(200);
    t += 60_000;
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });
});
