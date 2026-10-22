// Connects @heydelph to the X app (PIN sign-in, once). The app can live on any X developer account:
// @heydelph approves it, and the app gets a token that posts as her. Keys stay in the keys file.
//   node scripts/x-auth.ts start       prints the link to open while logged into @heydelph
//   node scripts/x-auth.ts pin 1234567 finishes with the PIN X shows, and saves her token
// Run as DELPHI's service user (sudo -u ayinde …). Nothing secret is ever printed.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KEYS, loadXConfig, readSecret } from "../src/x/config.ts";
import { authHeader } from "../src/x/oauth.ts";

const [step, pin] = process.argv.slice(2);
const xcfg = loadXConfig();
const pending = join(KEYS, "heydelph-x.request");

function readVars(file: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readSecret(file).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\s]*)"?\s*$/);
    if (m) vars[m[1]!] = m[2]!;
  }
  return vars;
}

async function post(url: string, auth: string): Promise<URLSearchParams> {
  const res = await fetch(url, { method: "POST", headers: { authorization: auth }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`X ${res.status}: ${text.slice(0, 300)}`);
  return new URLSearchParams(text);
}

const vars = readVars(xcfg.keysFile);
if (!vars.X_API_KEY || !vars.X_API_SECRET) throw new Error(`${xcfg.keysFile} needs X_API_KEY and X_API_SECRET first`);
const app = { apiKey: vars.X_API_KEY, apiSecret: vars.X_API_SECRET };

if (step === "start") {
  const url = "https://api.x.com/oauth/request_token";
  const got = await post(url, authHeader({ ...app, accessToken: "", accessSecret: "" }, "POST", url, { oauth: { oauth_callback: "oob" } }));
  const token = got.get("oauth_token");
  const secret = got.get("oauth_token_secret");
  if (!token || !secret) throw new Error("X did not return a request token");
  writeFileSync(pending, `${token}\n${secret}\n`, { mode: 0o600 });
  console.log(`Open this while logged into @${xcfg.handle}, tap Authorize, and note the PIN:\nhttps://api.x.com/oauth/authorize?oauth_token=${token}`);
} else if (step === "pin" && pin && /^\d{4,10}$/.test(pin)) {
  const [token, secret] = readFileSync(pending, "utf8").trim().split("\n");
  if (!token || !secret) throw new Error("no sign-in in progress: run `start` first");
  const url = "https://api.x.com/oauth/access_token";
  const got = await post(url, authHeader({ ...app, accessToken: token, accessSecret: secret }, "POST", url, { oauth: { oauth_verifier: pin } }));
  const access = got.get("oauth_token");
  const accessSecret = got.get("oauth_token_secret");
  const who = got.get("screen_name");
  if (!access || !accessSecret) throw new Error("X did not return an access token");
  if (who?.toLowerCase() !== xcfg.handle.toLowerCase()) {
    throw new Error(`that sign-in was @${who}, not @${xcfg.handle}: open the link again while logged into @${xcfg.handle}`);
  }
  writeFileSync(
    xcfg.keysFile,
    `X_API_KEY=${app.apiKey}\nX_API_SECRET=${app.apiSecret}\nX_ACCESS_TOKEN=${access}\nX_ACCESS_SECRET=${accessSecret}\n`,
    { mode: 0o600 },
  );
  rmSync(pending, { force: true });
  console.log(`Connected: the app now posts as @${who}.`);
} else {
  console.error("usage: node scripts/x-auth.ts start | pin <digits>");
  process.exit(2);
}
