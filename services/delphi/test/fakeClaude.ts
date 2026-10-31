// A local fake of the Claude Messages API for DELPHI-on-X's tests: it answers each request with the next
// scripted assistant turn (any content blocks, server-tool blocks included) and keeps every request it
// was sent, so a test can check what she was given and what came back to her. Loopback only.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export type Seen = { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };
export type Turn = { content: Array<Record<string, unknown>>; stop_reason?: string; usage?: Record<string, unknown> };

export async function fakeClaude() {
  const seen: Seen[] = [];
  let turns: Turn[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      const turn = turns[seen.length - 1] ?? { content: [{ type: "text", text: "done" }] };
      const msg = {
        id: `msg_${seen.length}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: turn.content,
        stop_reason: turn.stop_reason ?? (turn.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1_000, ...turn.usage },
      };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    /** The assistant turns to answer with, in order; clears what was seen. */
    script(next: Turn[]) {
      turns = next;
      seen.length = 0;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
