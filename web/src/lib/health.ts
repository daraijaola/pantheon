import { readFile } from "node:fs/promises";

export type HealthState = "ok" | "unavailable" | "invalid" | "empty" | "stale";

export type HealthCheck = {
  name: "indexer" | "passport" | "trials" | "delphi" | "backup";
  ok: boolean;
  state: HealthState;
  latencyMs?: number;
  ageMs?: number;
};

export type HealthReport = {
  ok: boolean;
  checkedAt: string;
  checks: HealthCheck[];
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ReadFileLike = (path: string, encoding: BufferEncoding) => Promise<string>;

type Dependencies = {
  fetch?: FetchLike;
  readFile?: ReadFileLike;
  now?: () => number;
  timeoutMs?: number;
  serviceMaxAgeMs?: number;
  delphiMaxAgeMs?: number;
  backupMaxAgeMs?: number;
  indexerUrl?: string;
  passportUrl?: string;
  trialsUrl?: string;
  delphiUrl?: string;
  backupStatusFile?: string;
};

const HOUR = 60 * 60 * 1_000;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function valid(name: HealthCheck["name"], body: unknown): boolean {
  if (!object(body)) return false;
  if (name === "indexer") return object(body.pnth) && object(body.basket) && object(body.staking);
  if (name === "passport") return body.ok === true && typeof body.lastBlock === "string";
  if (name === "trials") return typeof body.round === "number" && typeof body.status === "string";
  return true;
}

async function endpoint(
  name: "indexer" | "passport" | "trials",
  url: string,
  fetcher: FetchLike,
  now: number,
  timeoutMs: number,
  maxAgeMs?: number,
): Promise<HealthCheck> {
  const started = performance.now();
  try {
    const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    const body: unknown = response.ok ? await response.json() : null;
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) return { name, ok: false, state: "unavailable", latencyMs };
    if (!valid(name, body)) return { name, ok: false, state: "invalid", latencyMs };
    if (maxAgeMs !== undefined && object(body) && typeof body.updatedAt === "number") {
      const ageMs = Math.max(0, now - body.updatedAt * 1_000);
      if (ageMs > maxAgeMs) return { name, ok: false, state: "stale", latencyMs, ageMs };
      return { name, ok: true, state: "ok", latencyMs, ageMs };
    }
    return { name, ok: true, state: "ok", latencyMs };
  } catch {
    return { name, ok: false, state: "unavailable", latencyMs: Math.round(performance.now() - started) };
  }
}

async function delphi(
  url: string,
  fetcher: FetchLike,
  now: number,
  timeoutMs: number,
  maxAgeMs: number,
): Promise<HealthCheck> {
  const started = performance.now();
  try {
    const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    const body: unknown = response.ok ? await response.json() : null;
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok || !object(body)) return { name: "delphi", ok: false, state: "unavailable", latencyMs };
    const newest = body.newestUpdateMs;
    if (typeof newest !== "number" || !Number.isFinite(newest)) return { name: "delphi", ok: false, state: "empty", latencyMs };
    const ageMs = Math.max(0, now - newest);
    if (body.ok !== true || ageMs > maxAgeMs) return { name: "delphi", ok: false, state: "stale", latencyMs, ageMs };
    return { name: "delphi", ok: true, state: "ok", latencyMs, ageMs };
  } catch {
    return { name: "delphi", ok: false, state: "unavailable", latencyMs: Math.round(performance.now() - started) };
  }
}

async function backup(path: string, reader: ReadFileLike, now: number, maxAgeMs: number): Promise<HealthCheck> {
  try {
    const body: unknown = JSON.parse(await reader(path, "utf8"));
    if (!object(body) || body.ok !== true || typeof body.completedAtMs !== "number") {
      return { name: "backup", ok: false, state: "invalid" };
    }
    const ageMs = Math.max(0, now - body.completedAtMs);
    if (ageMs > maxAgeMs) return { name: "backup", ok: false, state: "stale", ageMs };
    return { name: "backup", ok: true, state: "ok", ageMs };
  } catch {
    return { name: "backup", ok: false, state: "unavailable" };
  }
}

export async function healthReport(dependencies: Dependencies = {}): Promise<HealthReport> {
  const fetcher = dependencies.fetch ?? fetch;
  const reader = dependencies.readFile ?? readFile;
  const now = (dependencies.now ?? Date.now)();
  const timeoutMs = dependencies.timeoutMs ?? 3_000;
  const serviceMaxAgeMs = dependencies.serviceMaxAgeMs ?? 15 * 60 * 1_000;
  const indexerBase = process.env.INDEXER_API ?? "http://127.0.0.1:8789";
  const checks = await Promise.all([
    endpoint("indexer", dependencies.indexerUrl ?? `${indexerBase}/stats`, fetcher, now, timeoutMs, serviceMaxAgeMs),
    endpoint(
      "passport",
      dependencies.passportUrl ?? `${process.env.PASSPORT_API ?? "http://127.0.0.1:8787"}/passport/health`,
      fetcher,
      now,
      timeoutMs,
    ),
    endpoint(
      "trials",
      dependencies.trialsUrl ?? `${process.env.TRIALS_API ?? "http://127.0.0.1:8790"}/trials/current`,
      fetcher,
      now,
      timeoutMs,
    ),
    delphi(
      dependencies.delphiUrl ?? process.env.DELPHI_HEALTH_URL ?? "http://127.0.0.1:3210/v1/health",
      fetcher,
      now,
      timeoutMs,
      dependencies.delphiMaxAgeMs ?? 36 * HOUR,
    ),
    backup(
      dependencies.backupStatusFile ?? process.env.BACKUP_STATUS_FILE ?? "/var/lib/pantheon-ops/backup-status.json",
      reader,
      now,
      dependencies.backupMaxAgeMs ?? 36 * HOUR,
    ),
  ]);
  return { ok: checks.every((check) => check.ok), checkedAt: new Date(now).toISOString(), checks };
}
