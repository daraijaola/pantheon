// POST /api/ask-delphi: DELPHI answers a question, streamed as newline-delimited JSON:
//   {"type":"coins","coins":[…]}   the coins the question is about (first, so the page can name them)
//   {"type":"text","text":"…"}      pieces of the answer, in order
//   {"type":"done"} or {"type":"error","error":"…"}
// The answer comes from Claude (the model @heyDelph answers with) when a Claude key is set, else Grok
// when XAI_API_KEY is set, else straight from DELPHI's data (src/lib/delphi-chat.ts).
// Not under /api/delphi/: on the server, Caddy sends that path to the feed.
// Only JSON from this site is read (415 or 403 otherwise), and a visitor who asks too often gets a 429
// with Retry-After in seconds.

import { coinRef, context, findCoins, fromReports, hasModel, model, modelBudget, parseMessages, refuse, visitor, waitFor } from "@/lib/delphi-chat";
import { readDelphi } from "@/lib/delphi";

export async function POST(req: Request) {
  const refused = refuse(req.headers);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const wait = waitFor(visitor(req.headers));
  if (wait) return Response.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(wait) } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "BAD_REQUEST" }, { status: 400 });
  }
  const messages = parseMessages(body);
  if (!messages) return Response.json({ error: "BAD_REQUEST" }, { status: 400 });

  const data = await readDelphi();
  const coins = data ? findCoins(data, messages) : [];
  const useModel = hasModel() && modelBudget();
  const encoder = new TextEncoder();
  const upstream = new AbortController();
  req.signal.addEventListener("abort", () => upstream.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      send({ type: "coins", coins: coins.map(coinRef) });
      let said = false;
      try {
        if (useModel) {
          for await (const text of model(messages, context(data, coins), upstream.signal)) {
            said = true;
            send({ type: "text", text });
          }
        }
        if (!said) send({ type: "text", text: fromReports(data, coins) });
        send({ type: "done" });
      } catch (err) {
        if (upstream.signal.aborted) {
          // The visitor stopped it or left: nothing to send.
        } else if (!said) {
          // The model failed before saying anything: answer from the reports instead.
          console.warn("DELPHI chat: model failed, answering from the reports.", (err as Error).message);
          send({ type: "text", text: fromReports(data, coins) });
          send({ type: "done" });
        } else {
          send({ type: "error", error: "STREAM_BROKE" });
        }
      }
      try {
        controller.close();
      } catch {
        // Already closed by a cancelled request.
      }
    },
    cancel() {
      upstream.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      // Ask proxies not to hold the stream back: no-transform keeps Caddy's encoder from buffering it,
      // x-accel-buffering does the same for nginx.
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
