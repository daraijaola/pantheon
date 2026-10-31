// The extra abilities behind X_FEATURES, in one place. Each is a tool built for one answer from the
// snapshot and the services it needs, plus a few plain lines her instructions gain when it is on. With
// no feature on, none of this reaches Claude: same instructions, same tools, same checks as before.
//
// To add a tool (for example a contract check from src/safety.ts, or liquidity from src/kalos.ts):
//   1. add its name to X_FEATURES in src/x/config.ts;
//   2. add the service it needs to FeatureDeps in src/x/tooling.ts, and pass it in from scripts/x.ts;
//   3. write an ExtraTool with jsonTool() and add it to EXTRA_TOOLS below.
// Whatever a tool returns is remembered, so the reply checker accepts its numbers and addresses.
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { accountTool } from "./account.ts";
import { contractTool, liquidityTool } from "./safetytools.ts";
import { compareTool } from "./compare.ts";
import { NO_FEATURES, type Features } from "./config.ts";
import type { ExtraTool, ToolEnv } from "./tooling.ts";
import { walletTool } from "./wallet.ts";
import { WEB_GUIDANCE } from "./webtools.ts";

export type { ExtraTool, FeatureDeps, ToolEnv } from "./tooling.ts";

/** Every extra client tool, in the order she sees them. Register new ones here. */
export const EXTRA_TOOLS: readonly ExtraTool[] = [accountTool, walletTool, compareTool, contractTool, liquidityTool];

/** Feature "kalos": the coins on Kalos are in DELPHI's data too, with their own meaning of "launch". */
export const KALOS_GUIDANCE =
  "DELPHI also reads every coin trading on Kalos, Elysium's biggest DEX, with the same three checks. For a Kalos coin, the launch is the first liquidity added to its first Kalos pool, and the creator is the wallet that deployed the token. Coins too busy to read in full (KALOS, stKALOS) are read at launch and over the last day: say so when it matters. A Kalos coin was not launched on Ascend: never call it an Ascend coin.";

/** The extra tools that are on and have what they need. */
export function extraTools(features: Features, env: ToolEnv): BetaRunnableTool[] {
  return EXTRA_TOOLS.filter((t) => features.has(t.feature))
    .map((t) => t.build(env))
    .filter((t): t is BetaRunnableTool => t !== null);
}

/** The lines her instructions gain for the features that are on ("" when none is). */
export function featureGuidance(features: Features = NO_FEATURES): string {
  if (features.size === 0) return "";
  const lines = [...(features.has("kalos") ? [KALOS_GUIDANCE] : []), ...(features.has("web") ? [WEB_GUIDANCE] : []), ...EXTRA_TOOLS.filter((t) => features.has(t.feature)).map((t) => t.guidance)];
  return `More you can look up. Use these only when the question needs them: most questions are about wallets, and the tools above answer those.\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
