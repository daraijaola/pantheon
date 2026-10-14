// What the keeper remembers between runs: where it stopped looking for new stakers, who they are,
// where its rotating boost check is, and how far it has read the Passport service's change feed.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

const StateSchema = z.object({
  stakedCursor: z.string().regex(/^\d+$/),
  stakers: z.array(z.string().refine((a) => isAddress(a, { strict: false }))).transform((l) => l.map((a) => getAddress(a))),
  sweep: z.number().int().min(0),
  pokesSince: z.number().int().min(0),
});
export type State = { stakedCursor: string; stakers: Address[]; sweep: number; pokesSince: number };

export function loadState(path: string, fromBlock: bigint): State {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { stakedCursor: fromBlock.toString(), stakers: [], sweep: 0, pokesSince: 0 };
  }
  const parsed = StateSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`keeper state ${path} is damaged: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Written to a temporary file first, then renamed: a crash never leaves a half-written state. */
export function saveState(path: string, s: State): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
