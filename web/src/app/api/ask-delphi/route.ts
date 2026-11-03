// POST /api/ask-delphi: DELPHI answers a question, streamed as newline-delimited JSON:
//   {"type":"coins","coins":[…],"proofs":[…]}   first: the coins the question is about, so the page can
//                                  name them, and the transactions in her data, the only ones it links
//   {"type":"text","text":"…"}      pieces of the answer, in order
//   {"type":"done","sig":"…"} or {"type":"error","error":"…"}
// sig is her signature on the whole answer (no model key, no sig). The page sends it back with the
// answer, and an earlier answer only counts in the conversation if it carries one.
// The answer comes from Claude (the model @heyDelph answers with) when a Claude key is set, else Grok
// when XAI_API_KEY is set, else straight from DELPHI's data (src/lib/delphi-chat.ts).
// Not under /api/delphi/: on the server, Caddy sends that path to the feed.
// Only JSON from this site is read (415 or 403 otherwise), and a visitor who asks too often gets a 429
// with Retry-After in seconds.

import { ambiguousTicker, coinQuery, coinRef, context, findCoins, fromReports, hasModel, model, modelBudget, parseMessages, refuse, sign, txsIn, visitor, waitFor } from "@/lib/delphi-chat";
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
  const query = coinQuery(messages);
  const unknown = query && !coins.length ? query : null;
  const facts = context(data, coins, unknown);
  const useModel = hasModel() && !unknown && !ambiguousTicker(coins) && modelBudget();
  const encoder = new TextEncoder();
  const upstream = new AbortController();
  req.signal.addEventListener("abort", () => upstream.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      // Everything said so far, which is what gets signed at the end.
      let answer = "";
      const say = (text: string) => {
        answer += text;
        send({ type: "text", text });
      };
      const done = () => send({ type: "done", sig: sign(answer) ?? undefined });
      send({ type: "coins", coins: coins.map(coinRef), proofs: txsIn(facts) });
      try {
        if (useModel) for await (const text of model(messages, facts, upstream.signal)) say(text);
        if (!answer) say(fromReports(data, coins, unknown));
        done();
      } catch (err) {
        if (upstream.signal.aborted) {
          // The visitor stopped it or left: nothing to send.
        } else if (!answer) {
          // The model failed before saying anything: answer from the reports instead.
          console.warn("DELPHI chat: model failed, answering from the reports.", (err as Error).message);
          say(fromReports(data, coins, unknown));
          done();
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
