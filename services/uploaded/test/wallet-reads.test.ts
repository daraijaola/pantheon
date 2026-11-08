import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { WalletReads, READ_COOLDOWN, READ_MAX_AGE } from "../src/wallet-reads.ts";
import { buildApp } from "../src/api.ts";
import { Verdicts } from "../src/verdicts.ts";
import type { StageEvent } from "../src/scan.ts";

const wallet = `0x${"a".repeat(40)}`;
const other = `0x${"b".repeat(40)}`;
const stages = [{ stage: "wholeBag", ok: true, data: { coins: [] } }, { stage: "standing", ok: true, data: { complete: true } }] as unknown as StageEvent[];
const dirs: string[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), "wallet-reads-")); dirs.push(path); return path; };
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("persists owner-scoped reads and cooldown across restarts without rescanning fresh reads", async () => {
  const path = dir();
  let calls = 0;
  let now = 1_000_000;
  const scan = async function* () { calls++; yield* stages; };
  const reads = new WalletReads(path, scan, () => now);
  expect(reads.get(wallet)).toEqual({ read: null, refreshAfter: 0 });
  await Promise.all([reads.refresh(wallet.toUpperCase().replace("0X", "0x")), reads.refresh(wallet)]);
  expect(calls).toBe(1);
  const restarted = new WalletReads(path, scan, () => now);
  expect(restarted.get(wallet).read?.readAt).toBe(now);
  expect(restarted.get(other).read).toBeNull();
  await restarted.refresh(wallet);
  expect(calls).toBe(1);
  expect(statSync(join(path, `${wallet}.json`)).mode & 0o777).toBe(0o600);
  for await (const event of restarted.scan(wallet)) expect(event.ok).toBe(true);
  expect(calls).toBe(1);
  now += READ_COOLDOWN;
  await restarted.refresh(wallet);
  expect(calls).toBe(2);
  now += READ_MAX_AGE + 1;
  for await (const event of restarted.scan(wallet)) expect(event.ok).toBe(true);
  expect(calls).toBe(3);
});

it("keeps the last good read and throttles retries when a scan fails or is empty", async () => {
  let now = 1_000_000;
  let broken = false;
  const reads = new WalletReads(dir(), async function* () { if (!broken) yield* stages; }, () => now);
  const first = await reads.refresh(wallet);
  broken = true;
  now += READ_COOLDOWN;
  await expect(reads.refresh(wallet)).rejects.toThrow("READ_INCOMPLETE");
  expect(reads.get(wallet).read).toEqual(first.read);
  expect((await reads.refresh(wallet)).read).toEqual(first.read);
  expect(reads.get(wallet).refreshAfter).toBe(now + READ_COOLDOWN);
});

it("does not overwrite a saved read with failed stages or a broken file", async () => {
  const path = dir();
  const reads = new WalletReads(path, async function* () { yield { stage: "wholeBag", ok: false, error: "TIMEOUT" }; });
  await expect(reads.refresh(wallet)).rejects.toThrow("READ_INCOMPLETE");
  expect(reads.get(wallet).read).toBeNull();
  writeFileSync(join(path, `${wallet}.json`), "broken");
  expect(() => reads.get(wallet)).toThrow();
  expect(readFileSync(join(path, `${wallet}.json`), "utf8")).toBe("broken");
  expect(() => reads.get("../other")).toThrow("INVALID_ADDRESS");
});

it("serves empty, refreshed and cached SSE reads privately with address validation", async () => {
  const reads = new WalletReads(dir(), async function* () { yield* stages; });
  const verdicts = new Verdicts(new URL("./fixtures/scan.json", import.meta.url).pathname);
  verdicts.refresh();
  const app = buildApp(verdicts, { reads });
  const empty = await app.inject(`/wallets/${wallet}/read`);
  expect(empty.json().read).toBeNull();
  expect(empty.headers["cache-control"]).toBe("no-store");
  expect((await app.inject({ method: "POST", url: `/wallets/${wallet}/read` })).json().read.wallet).toBe(wallet);
  expect((await app.inject(`/wallets/${other}/read`)).json().read).toBeNull();
  const sse = await app.inject(`/wallets/${wallet}/scan`);
  expect(sse.body).toContain('"stage":"wholeBag"');
  expect(sse.body).toContain('event: done');
  expect((await app.inject('/wallets/invalid/read')).statusCode).toBe(400);
  await app.close();
});

it("returns an unavailable result for a failed fresh read", async () => {
  const reads = new WalletReads(dir(), async function* () { yield* await Promise.reject<StageEvent[]>(new Error("offline")); });
  const verdicts = new Verdicts(new URL("./fixtures/scan.json", import.meta.url).pathname);
  const app = buildApp(verdicts, { reads });
  expect((await app.inject({ method: "POST", url: `/wallets/${wallet}/read` })).statusCode).toBe(503);
  await app.close();
});
