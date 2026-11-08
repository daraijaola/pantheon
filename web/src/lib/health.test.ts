import assert from "node:assert/strict";
import { test } from "node:test";

const { healthReport } = (await import(new URL("./health.ts", import.meta.url).href)) as typeof import("./health");

const NOW = Date.UTC(2026, 10, 8, 12);

const urls = {
  indexerUrl: "https://local/indexer",
  passportUrl: "https://local/passport",
  passportStatsUrl: "https://local/passport-stats",
  trialsUrl: "https://local/trials",
  delphiUrl: "https://local/delphi",
  backupStatusFile: "/backup.json",
};

function response(url: string, newestUpdateMs = NOW - 60_000): Response {
  if (url.endsWith("/indexer")) return Response.json({ pnth: {}, basket: {}, staking: {}, updatedAt: NOW / 1_000 - 60 });
  if (url.endsWith("/passport")) return Response.json({ ok: true, lastBlock: "42", relayerBalance: "10000000000000000" });
  if (url.endsWith("/passport-stats")) return Response.json({ linked: 4, valid: 4, updatedAt: NOW / 1_000 - 60 });
  if (url.endsWith("/trials")) return Response.json({ round: 5, status: "closed" });
  return Response.json({ ok: true, newestUpdateMs });
}

test("healthy means every service, fresh DELPHI data and a verified recent backup", async () => {
  const report = await healthReport({
    ...urls,
    now: () => NOW,
    fetch: async (url) => response(url),
    readFile: async () => JSON.stringify({ ok: true, completedAtMs: NOW - 60_000 }),
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(({ name, state }) => [name, state]), [
    ["indexer", "ok"],
    ["passport", "ok"],
    ["trials", "ok"],
    ["delphi", "ok"],
    ["backup", "ok"],
  ]);
});

for (const state of ["ok", "empty", "unavailable"] as const) {
  test(`the dedicated DELPHI port reports ${state} without an override`, async () => {
    const original = process.env.DELPHI_HEALTH_URL;
    delete process.env.DELPHI_HEALTH_URL;
    let requests = 0;
    try {
      const report = await healthReport({
        ...urls,
        delphiUrl: undefined,
        now: () => NOW,
        fetch: async (url) => {
          if (url === "http://127.0.0.1:3310/v1/health") {
            requests++;
            if (state === "unavailable") throw new Error("Feed unavailable");
            if (state === "empty") return Response.json({ ok: true, newestUpdateMs: null });
          }
          return response(url);
        },
        readFile: async () => JSON.stringify({ ok: true, completedAtMs: NOW - 60_000 }),
      });
      assert.equal(requests, 1);
      assert.equal(report.ok, state === "ok");
      assert.equal(report.checks.find((check) => check.name === "delphi")?.state, state);
    } finally {
      if (original === undefined) delete process.env.DELPHI_HEALTH_URL;
      else process.env.DELPHI_HEALTH_URL = original;
    }
  });
}

for (const injected of [false, true]) {
  test(`DELPHI health respects the ${injected ? "injected URL over the environment" : "environment URL over the default"}`, async () => {
    const original = process.env.DELPHI_HEALTH_URL;
    const override = "http://127.0.0.1:4310/v1/health";
    process.env.DELPHI_HEALTH_URL = override;
    const requests: string[] = [];
    try {
      const report = await healthReport({
        ...urls,
        delphiUrl: injected ? urls.delphiUrl : undefined,
        now: () => NOW,
        fetch: async (url) => {
          requests.push(url);
          return response(url);
        },
        readFile: async () => JSON.stringify({ ok: true, completedAtMs: NOW - 60_000 }),
      });
      assert.equal(report.ok, true);
      assert.ok(requests.includes(injected ? urls.delphiUrl : override));
      assert.ok(!requests.includes("http://127.0.0.1:3310/v1/health"));
    } finally {
      if (original === undefined) delete process.env.DELPHI_HEALTH_URL;
      else process.env.DELPHI_HEALTH_URL = original;
    }
  });
}

test("an empty DELPHI feed is unhealthy even if its old endpoint says ok", async () => {
  const report = await healthReport({
    ...urls,
    now: () => NOW,
    fetch: async (url) => (url.endsWith("/delphi") ? Response.json({ ok: true, newestUpdateMs: null }) : response(url)),
    readFile: async () => JSON.stringify({ ok: true, completedAtMs: NOW - 60_000 }),
  });
  assert.equal(report.ok, false);
  const delphi = report.checks.find((check) => check.name === "delphi");
  assert.equal(delphi?.ok, false);
  assert.equal(delphi?.state, "empty");
});

test("stale DELPHI data and a stale backup are named rather than hidden", async () => {
  const report = await healthReport({
    ...urls,
    now: () => NOW,
    delphiMaxAgeMs: 2 * 60 * 60 * 1_000,
    backupMaxAgeMs: 2 * 60 * 60 * 1_000,
    fetch: async (url) => response(url, NOW - 3 * 60 * 60 * 1_000),
    readFile: async () => JSON.stringify({ ok: true, completedAtMs: NOW - 4 * 60 * 60 * 1_000 }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "delphi")?.state, "stale");
  assert.equal(report.checks.find((check) => check.name === "backup")?.state, "stale");
});

test("bad service data and a failed backup status do not pass", async () => {
  const report = await healthReport({
    ...urls,
    now: () => NOW,
    fetch: async (url) => (url.endsWith("/indexer") ? Response.json({ ok: true }) : response(url)),
    readFile: async () => JSON.stringify({ ok: false, completedAtMs: NOW }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "indexer")?.state, "invalid");
  assert.equal(report.checks.find((check) => check.name === "backup")?.state, "invalid");
});

test("a running service with old indexed data is stale, not healthy", async () => {
  const report = await healthReport({
    ...urls,
    now: () => NOW,
    serviceMaxAgeMs: 5 * 60 * 1_000,
    fetch: async (url) =>
      url.endsWith("/indexer")
        ? Response.json({ pnth: {}, basket: {}, staking: {}, updatedAt: NOW / 1_000 - 600 })
        : response(url),
    readFile: async () => JSON.stringify({ ok: true, completedAtMs: NOW - 60_000 }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "indexer")?.state, "stale");
});

test("Passport registry or relayer failures make the aggregate health check fail", async () => {
  const report = await healthReport({
    ...urls,
    now: () => NOW,
    fetch: async (url) =>
      url.endsWith("/passport")
        ? Response.json({ ok: false, lastBlock: null, relayerBalance: "0" }, { status: 503 })
        : response(url),
    readFile: async () => JSON.stringify({ ok: true, completedAtMs: NOW - 60_000 }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "passport")?.state, "unavailable");
});

test("Passport database failures make the aggregate health check fail", async () => {
  const report = await healthReport({
    ...urls,
    now: () => NOW,
    fetch: async (url) => (url.endsWith("/passport-stats") ? Response.json({ error: "INTERNAL" }, { status: 500 }) : response(url)),
    readFile: async () => JSON.stringify({ ok: true, completedAtMs: NOW - 60_000 }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "passport")?.state, "unavailable");
});
