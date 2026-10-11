// Fake HL `/info` on 127.0.0.1, answering from the captured fixtures (keyed by request type + user).
// Unknown users get the `empty` fixture, like a never-used address on the live API.
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { GENESIS_WINDOW_MS } from "../src/config.ts";

const DIR = fileURLToPath(new URL("./fixtures/hl/", import.meta.url));

export type Fixture = {
  address: string;
  capturedAtMs: number;
  userRole: unknown;
  spotClearinghouseState: unknown;
  borrowLendUserState: unknown;
  delegatorSummary: unknown;
  ledger0: Array<{ time: number }>;
  ledgerGenesis: Array<{ time: number }>;
  portfolio: unknown;
  subAccounts: unknown;
  hyperevm: Record<string, number>;
  expected: Record<string, unknown>;
};

/** Account fixtures by name (file name without .json). */
export function loadFixtures(): Record<string, Fixture> {
  const out: Record<string, Fixture> = {};
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".json") || f === "eip712_crosscheck.json") continue;
    out[f.slice(0, -5)] = JSON.parse(readFileSync(DIR + f, "utf8")) as Fixture;
  }
  return out;
}

// Live 2026-10-11 (spec §2.2): the master behind the `agent` fixture lists it as its API wallet.
const EXTRA_AGENTS: Record<string, unknown> = {
  "0x5b5d51203a0f9079f8aeb098a6523a13f298c060": [
    { name: "IMS", address: "0xe2e497f115b20015ef150ecd78ae237082e6a068", validUntil: 1796032025040 },
  ],
};

const DESERIALIZE_ERROR = "Failed to deserialize the JSON body into the target type";

export type Fault =
  | { status: number; body?: string; headers?: Record<string, string> }
  | { hangMs: number }
  | { destroy: true };

export type MockHl = {
  url: string;
  /** Every parsed request body, in order. */
  requests: Array<Record<string, unknown>>;
  /** The next `count` requests get `fault` instead of an answer. */
  failNext(count: number, fault: Fault): void;
  close(): Promise<void>;
};

export async function startMockHl(fixtures: Record<string, Fixture> = loadFixtures()): Promise<MockHl> {
  const byUser = new Map(Object.values(fixtures).map((fx) => [fx.address.toLowerCase(), fx]));
  const fallback = fixtures.empty;
  if (!fallback) throw new Error("mockHl needs the `empty` fixture");
  const requests: Array<Record<string, unknown>> = [];
  const faults: Fault[] = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBody(req);
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
    } catch {
      body = undefined;
    }

    const fault = faults.shift();
    if (fault) {
      if ("destroy" in fault) return void req.socket.destroy();
      if ("hangMs" in fault) await new Promise((r) => setTimeout(r, fault.hangMs));
      else {
        res.writeHead(fault.status, { "content-type": "text/plain", ...fault.headers });
        return void res.end(fault.body ?? "");
      }
    }

    const answer = body === undefined ? undefined : route(body, byUser, fallback);
    if (answer === undefined) {
      res.writeHead(422, { "content-type": "text/plain; charset=utf-8" });
      return void res.end(DESERIALIZE_ERROR);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.value));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/info`,
    requests,
    failNext: (count, fault) => faults.push(...Array<Fault>(count).fill(fault)),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** `{ value }` for a known request type (value may be null); undefined → 422 like the live API. */
function route(body: Record<string, unknown>, byUser: Map<string, Fixture>, fallback: Fixture): { value: unknown } | undefined {
  if (typeof body.user !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.user)) return undefined;
  const user = body.user.toLowerCase();
  const fx = byUser.get(user) ?? fallback;
  switch (body.type) {
    case "userRole":
      return { value: byUser.has(user) ? fx.userRole : { role: "missing" } };
    case "spotClearinghouseState":
      return { value: fx.spotClearinghouseState };
    case "borrowLendUserState":
      return { value: fx.borrowLendUserState };
    case "delegatorSummary":
      return { value: fx.delegatorSummary };
    case "portfolio":
      return { value: fx.portfolio };
    case "subAccounts":
      return { value: fx.subAccounts };
    case "extraAgents":
      return { value: EXTRA_AGENTS[user] ?? [] };
    case "userToMultiSigSigners":
      return { value: null };
    case "clearinghouseState": {
      // Fixtures did not capture main-account perps state: answer the live shape of an empty account.
      const zero = { accountValue: "0.0", totalNtlPos: "0.0", totalRawUsd: "0.0", totalMarginUsed: "0.0" };
      return {
        value: {
          marginSummary: zero,
          crossMarginSummary: zero,
          crossMaintenanceMarginUsed: "0.0",
          withdrawable: "0.0",
          assetPositions: [],
          time: fx.capturedAtMs,
        },
      };
    }
    case "userNonFundingLedgerUpdates": {
      if (typeof body.startTime !== "number") return undefined;
      const start = body.startTime;
      const end = typeof body.endTime === "number" ? body.endTime : Number.MAX_SAFE_INTEGER;
      const inGenesisWindow = start >= GENESIS_WINDOW_MS.start && end <= GENESIS_WINDOW_MS.end;
      const source = inGenesisWindow ? fx.ledgerGenesis : fx.ledger0;
      return { value: source.filter((e) => e.time >= start && e.time <= end) };
    }
    default:
      return undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
