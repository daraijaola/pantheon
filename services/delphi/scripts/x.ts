// DELPHI on X (@heydelph): reads her mentions every ~45 s and answers questions about Ascend coins
// with DELPHI's data. Starts in shadow mode (answers saved as drafts in out/x/drafts.jsonl, nothing
// posted); X_MODE=live posts them. Run it by hand or as a service:
//   node scripts/x.ts                     the loop
//   node scripts/x.ts --check             check the keys and the data, then stop (nothing is posted)
//   node scripts/x.ts --ask "is this safe?" [--under "post text with 0x… or $TICKER"]
//                                         answer one made-up question locally; nothing touches X
// The first loop run only notes where her mentions stand; she answers what comes after that.
import Anthropic from "@anthropic-ai/sdk";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { makeClient } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { Explorer } from "../src/explorer.ts";
import { Store } from "../src/store.ts";
import { answer, costOf, type Context } from "../src/x/agent.ts";
import { XApi, XError, type Post } from "../src/x/api.ts";
import { handleMention, type BotConfig } from "../src/x/bot.ts";
import { loadXConfig, loadXKeys, readSecret } from "../src/x/config.ts";
import { ChainView } from "../src/x/data.ts";
import { findCoin } from "../src/x/find.ts";
import { XState } from "../src/x/state.ts";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const log = (m: string) => console.error(`[delphi-x ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cfg = loadConfig();
const xcfg = loadXConfig();
// DELPHI's cache belongs to its service user. Opening it as anyone else leaves lock files that
// user can't write, which breaks the next scan: stop before touching it.
if (existsSync(cfg.dbPath)) {
  try {
    accessSync(cfg.dbPath, constants.W_OK);
  } catch {
    console.error(`run this as DELPHI's service user (sudo -u ayinde node scripts/x.ts …): ${cfg.dbPath} is not writable for you`);
    process.exit(2);
  }
}
const store = new Store(cfg.dbPath);
const view = new ChainView({
  client: makeClient(cfg.elysiumRpc, (ms, what) => log(`RPC asked us to slow down (${what}): waiting ${ms / 1000} s`)),
  store,
  cfg,
  explorer: new Explorer(cfg.explorerApi),
  log,
});

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => ((stopping = true), log(`${sig}: stopping after this step`)));

try {
  log("reading DELPHI's data…");
  const t0 = Date.now();
  let snap = await view.refresh();
  log(`${snap.ws.reports.size} coins up to block ${snap.head} (${Math.round((Date.now() - t0) / 1000)} s)`);

  const claude = new Anthropic({ apiKey: readSecret(xcfg.claudeKeyFile), maxRetries: 3 });
  const think = async (c: Context, s: typeof snap) => {
    const out = await answer(claude, s, c, { model: xcfg.model, handle: xcfg.handle, signal: AbortSignal.timeout(150_000) });
    const cost = costOf(xcfg.model, out.usage);
    log(`  ${out.answer.kind}: ${out.toolCalls.join(" → ")} · ${out.usage.requests} requests · about $${cost.toFixed(3)}`);
    return { answer: out.answer, cost };
  };

  if (args.includes("--ask")) {
    // A made-up question, answered locally (nothing touches X).
    const q = arg("--ask") ?? "is this safe?";
    const under = arg("--under");
    const mk = (id: string, text: string): Post => ({ id, text });
    const posts = [{ post: mk("1", q), where: "the question" }, ...(under ? [{ post: mk("2", under), where: "the post it replies to" }] : [])];
    const found = findCoin(snap.ws, posts);
    if (found.kind === "coin") snap = await view.forCoin(found.token);
    log(`coin match: ${JSON.stringify(found)}`);
    const { answer: a } = await think({ question: { author: "tester", text: q }, parent: under ? { author: "coin", text: under } : null, found }, snap);
    console.log(a.kind === "reply" ? `\n${a.text}\n` : `\n(silent: ${a.reason})\n`);
  } else {
    const api = new XApi(loadXKeys(xcfg.keysFile));
    const me = await api.me();
    if (me.username.toLowerCase() !== xcfg.handle.toLowerCase()) throw new Error(`these keys post as @${me.username}, not @${xcfg.handle}`);
    log(`keys work: posting as @${me.username} (${xcfg.mode} mode${xcfg.allow ? `, test list: ${[...xcfg.allow].join(", ")}` : ""})`);
    if (args.includes("--check")) process.exit(0);

    const state = new XState(xcfg.statePath);
    const bot: BotConfig = { selfId: me.id, handle: me.username, mode: xcfg.mode, dailyCap: xcfg.dailyCap, perUserHourly: xcfg.perUserHourly, allow: xcfg.allow };
    mkdirSync(dirname(xcfg.draftsPath), { recursive: true });
    const onDraft = (d: object) => appendFileSync(xcfg.draftsPath, `${JSON.stringify({ at: new Date().toISOString(), ...d })}\n`);

    let since = state.value("since_id");
    if (!since) {
      const first = await api.mentions(me.id, null);
      since = first.newestId ?? "1";
      state.setValue("since_id", since);
      log(`first run: starting after mention ${since}`);
    }
    let lastRefresh = Date.now();
    while (!stopping) {
      try {
        if (Date.now() - lastRefresh > xcfg.refreshSec * 1000) {
          snap = await view.refresh();
          lastRefresh = Date.now();
        }
        const page = await api.mentions(me.id, since);
        for (const m of page.posts) {
          if (stopping) break;
          if (state.spentSince(Date.now() - 86_400_000) >= xcfg.dailyUsd) {
            log(`daily Claude budget ($${xcfg.dailyUsd}) reached: leaving ${m.id} for tomorrow`);
            break;
          }
          const out = await handleMention(m, page, bot, {
            api,
            state,
            snapshot: () => view.snapshot(),
            refreshCoin: (t) => view.forCoin(t),
            answer: think,
            onDraft,
            log,
          });
          log(`${out.id}: ${out.status}${out.reason ? ` (${out.reason})` : ""}${out.text ? `: ${out.text}` : ""}`);
          since = m.id;
          state.setValue("since_id", since);
        }
      } catch (err) {
        if (err instanceof XError && err.status === 429) {
          const wait = err.resetAt ? Math.max(15, err.resetAt - Math.floor(Date.now() / 1000)) : 300;
          log(`X rate limit: waiting ${wait} s`);
          await sleep(wait * 1000);
          continue;
        }
        if (err instanceof XError && (err.status === 401 || err.status === 403)) throw err;
        log(`loop error (retrying): ${(err as Error).message}`);
      }
      for (let s = 0; s < xcfg.pollSec && !stopping; s++) await sleep(1000);
    }
    state.close();
  }
} finally {
  store.close();
}
