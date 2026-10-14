import { readFile } from "node:fs/promises";
import path from "node:path";

// The site's art is made of our own contract code: the fork test that proves PANTHEON's contracts
// can hold an Ascend creator role and collect its fees.
export async function readOurCode(): Promise<string> {
  "use cache";
  try {
    return await readFile(path.join(process.cwd(), "..", "test", "fork", "AscendPoC.t.sol"), "utf8");
  } catch {
    return "contract RoleTaker{constructor(IAscendLaunchpad lp,PoolId id){lp.acceptCreator(id);}}";
  }
}

/** The same code as one unbroken string (comments dropped, whitespace removed), to fill letters and buildings. */
export function packCode(code: string): string {
  return code
    .slice(Math.max(0, code.indexOf("contract ")))
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("")
    .replace(/\s+/g, "");
}
