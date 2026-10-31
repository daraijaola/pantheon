// Recorded answers for tests. `recordingFetch` wraps a real fetch and keeps every answer: JSON-RPC
// calls one by one (so a replay does not depend on how calls were batched or numbered) and other HTTP
// requests by method, URL and body. `replayFetch` answers from the tape only and fails loudly on
// anything that was not recorded. A safety report is pinned to one block, so a replay is exact.
import type { Fetch } from "./http.ts";

export type RpcEntry = { method: string; params: unknown[]; result?: unknown; error?: { code: number; message: string; data?: unknown } };
export type HttpEntry = { method: string; url: string; body?: string; status: number; response: unknown };
/** `block`: the block the recorded run was pinned to, so a replay asks for the same one. */
export type Tape = { note?: string; recordedAt?: string; block?: string; rpc: RpcEntry[]; http: HttpEntry[] };

type RpcRequest = { jsonrpc: string; id: number; method: string; params: unknown[] };

const rpcKey = (method: string, params: unknown[]) => JSON.stringify([method, params]);
const httpKey = (method: string, url: string, body?: string) => `${method} ${url} ${body ?? ""}`;

/** The JSON-RPC calls in a request body, or null when it is not JSON-RPC. */
function rpcCalls(body: unknown): RpcRequest[] | null {
  if (typeof body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.every((c) => typeof c === "object" && c !== null && (c as RpcRequest).jsonrpc === "2.0" && typeof (c as RpcRequest).method === "string")
      ? (list as RpcRequest[])
      : null;
  } catch {
    return null;
  }
}

export function emptyTape(note?: string): Tape {
  return { ...(note ? { note } : {}), recordedAt: new Date().toISOString(), rpc: [], http: [] };
}

/** A fetch that does the real request and writes every answer onto `tape`. */
export function recordingFetch(inner: Fetch, tape: Tape): Fetch {
  const seenRpc = new Set(tape.rpc.map((e) => rpcKey(e.method, e.params)));
  const seenHttp = new Set(tape.http.map((e) => httpKey(e.method, e.url, e.body)));
  return async (url, init) => {
    const res = await inner(url, init);
    const text = await res.text();
    const calls = rpcCalls(init?.body);
    if (calls && res.ok) {
      const parsed: unknown = JSON.parse(text);
      const answers = new Map((Array.isArray(parsed) ? parsed : [parsed]).map((a: { id: number }) => [a.id, a as { result?: unknown; error?: RpcEntry["error"] }]));
      for (const c of calls) {
        const a = answers.get(c.id);
        const key = rpcKey(c.method, c.params);
        // "Slow down" answers are the node's mood, not its answer: never recorded.
        if (!a || seenRpc.has(key) || (a.error && [-32005, 429, -32007, -32017].includes(a.error.code))) continue;
        seenRpc.add(key);
        tape.rpc.push(a.error ? { method: c.method, params: c.params, error: a.error } : { method: c.method, params: c.params, result: a.result });
      }
    } else if (!calls) {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      const key = httpKey(method, url, body);
      if (!seenHttp.has(key) && res.status < 500 && res.status !== 429) {
        seenHttp.add(key);
        let response: unknown = text;
        try {
          response = JSON.parse(text);
        } catch {
          /* keep the text */
        }
        tape.http.push({ method, url, ...(body !== undefined ? { body } : {}), status: res.status, response });
      }
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** A fetch that answers from `tape` only. */
export function replayFetch(tape: Tape): Fetch {
  const rpc = new Map(tape.rpc.map((e) => [rpcKey(e.method, e.params), e]));
  const http = new Map(tape.http.map((e) => [httpKey(e.method, e.url, e.body), e]));
  return async (url, init) => {
    const calls = rpcCalls(init?.body);
    if (calls) {
      const out = calls.map((c) => {
        const e = rpc.get(rpcKey(c.method, c.params));
        if (!e) throw new Error(`not on the tape: ${c.method} ${JSON.stringify(c.params).slice(0, 300)}`);
        return e.error ? { jsonrpc: "2.0", id: c.id, error: e.error } : { jsonrpc: "2.0", id: c.id, result: e.result };
      });
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    const e = http.get(httpKey(method, url, body));
    if (!e) throw new Error(`not on the tape: ${method} ${url} ${body ?? ""}`);
    return new Response(typeof e.response === "string" ? e.response : JSON.stringify(e.response), { status: e.status, headers: { "content-type": "application/json" } });
  };
}
