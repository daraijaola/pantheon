// What every extra DELPHI-on-X tool is made of (see src/x/features.ts for the list): the services it may
// use, what it gets for one answer, and jsonTool(), which wraps a plain function as a read-only tool
// whose answers the reply checker remembers. Kept apart from the list so the tools can import it.
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { Address } from "viem";
import type { LiquidityReport } from "../kalos.ts";
import type { SafetySummary } from "../safety-run.ts";
import type { AccountLookup } from "./account.ts";
import type { Feature } from "./config.ts";
import type { ChainReader, FirstFundingFn } from "./wallet.ts";
import type { Snapshot } from "./xtools.ts";

/** The services the extra tools use, injected so tests can use fakes. A tool whose service is missing is left out. */
export type FeatureDeps = {
  /** Chain reads for wallet_profile (scripts/x.ts builds it from the RPC client with chainReader()). */
  chain?: ChainReader;
  /** The first HYPE a wallet ever received (src/funding.ts). Without it, wallet_profile uses DELPHI's cached funding. */
  firstFunding?: FirstFundingFn;
  /** X account lookups, cached in x.db (XAccounts). */
  accounts?: AccountLookup;
  /** A coin's contract and market checks, kept a day (src/safety-run.ts). */
  safety?: (token: Address) => Promise<SafetySummary>;
  /** A Kalos coin's pools and LP owners, from the last Kalos read. */
  liquidity?: (token: Address) => LiquidityReport | undefined;
};

/** What a tool gets for one answer. */
export type ToolEnv = {
  snap: Snapshot;
  deps: FeatureDeps;
  /** The question is about PANTHEON or PNTH (only then may a reply name them). */
  aboutUs: boolean;
  /** Remembers a result: the reply may then use its numbers and addresses. */
  record: (name: string, result: string) => void;
  /** This result gave a coin's verdict and checks, as coin_report does: a reply may now be about that coin. */
  coinChecked: (token: string) => void;
};

/** One extra tool: which feature turns it on, the lines it adds to her instructions, and how to build it. */
export type ExtraTool = {
  feature: Feature;
  name: string;
  /** One or two short lines for her instructions: when to use it, and what not to say. */
  guidance: string;
  /** The tool for one answer, or null when a service it needs is missing. */
  build: (env: ToolEnv) => BetaRunnableTool | null;
};

/**
 * A read-only tool that answers with JSON and remembers what it said. `run` may be async. An error
 * becomes `{ error }` for her to read, never a crash of the whole answer.
 */
export function jsonTool<S extends z.ZodType>(
  env: ToolEnv,
  spec: { name: string; description: string; inputSchema: S; run: (input: z.infer<S>) => unknown },
): BetaRunnableTool {
  return betaZodTool({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    run: async (input) => {
      let out: string;
      try {
        out = JSON.stringify(await spec.run(input));
      } catch (err) {
        out = JSON.stringify({ error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      }
      env.record(spec.name, out);
      return out;
    },
  });
}
