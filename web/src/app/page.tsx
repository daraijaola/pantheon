import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { CodeHeadline } from "@/components/code-type/code-headline";
import { CodeRain } from "@/components/code-type/code-rain";
import { CodeTouch } from "@/components/code-type/code-touch";
import { CodeWordmark } from "@/components/code-type/code-wordmark";
import { IndexSection } from "@/components/index-section/index-section";
import type { HeadlineWord } from "@/components/code-type/layout";

const SENTENCE = "The best of Ascend, in one token.";

const WORDS: HeadlineWord[] = [
  { text: "THE" },
  { text: "BEST" },
  { text: "OF" },
  { text: "ASCEND,", breakAfter: true },
  { text: "IN", muted: true },
  { text: "ONE", muted: true },
  { text: "TOKEN.", muted: true },
];

const NAV = ["Index", "Trials", "Passport", "Covenant"];

// The letters and the background are made of our own contract code: the fork test that proves
// PANTHEON's contracts can hold an Ascend creator role and collect its fees.
async function readOurCode(): Promise<string> {
  "use cache";
  try {
    return await readFile(path.join(process.cwd(), "..", "test", "fork", "AscendPoC.t.sol"), "utf8");
  } catch {
    return "contract RoleTaker{constructor(IAscendLaunchpad lp,PoolId id){lp.acceptCreator(id);}}";
  }
}

// Clear around the heading (radial) and fade out before the hands (linear); both masks must pass.
const RAIN_MASK =
  "radial-gradient(ellipse 60% 40% at 50% 34%, transparent 0%, transparent 30%, #000 88%), linear-gradient(to bottom, #000 0%, #000 45%, transparent 66%)";

export default async function Home() {
  const code = await readOurCode();
  const fill = code
    .slice(Math.max(0, code.indexOf("contract ")))
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("")
    .replace(/\s+/g, "");

  return (
    <main className="relative min-h-svh bg-paper text-ink">
      {/* Frame: the two rails of the 1112px column run the full page. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-y-0 left-1/2 z-20 w-[min(1112px,calc(100%-32px))] -translate-x-1/2 border-x border-rule"
      />

      <header className="relative z-30 border-b border-rule bg-paper/90 backdrop-blur-sm">
        <div className="mx-auto flex h-[72px] w-[min(1000px,calc(100%-64px))] items-center justify-between lg:h-[100px]">
          <Link href="/" aria-label="PANTHEON home" className="text-ink">
            <CodeWordmark text="PANTHEON" module={2.2} />
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
            {NAV.map((item) => (
              <a key={item} href="#" className="rounded-lg px-2.5 py-1.5 text-[15px] text-ink/80 transition-colors hover:bg-ink/5 hover:text-ink">
                {item}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <a href="#" className="hidden rounded-lg px-2.5 py-1.5 text-[14px] font-[450] text-ink/80 hover:bg-ink/5 sm:block">
              GitHub
            </a>
            <button type="button" className="h-8 rounded-lg bg-ink/5 px-3 text-[14px] font-[450] transition-colors hover:bg-ink/10">
              Connect wallet
            </button>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden border-b border-rule">
        {/* Falling code stays inside the frame, like Firecrawl keeps its decoration inside the column. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-[min(1112px,calc(100%-32px))] -translate-x-1/2 overflow-hidden">
          <CodeRain source={code} className="absolute inset-0" style={{ maskImage: RAIN_MASK, WebkitMaskImage: RAIN_MASK, maskComposite: "intersect", WebkitMaskComposite: "source-in" }} />
        </div>

        {/* Firecrawl's rhythm: heading where theirs sits (198px under the header), then sub 16 · buttons 24. */}
        <div className="relative mx-auto flex w-[min(1112px,calc(100%-32px))] flex-col items-center px-4 pt-24 pb-10 text-center lg:pt-[198px] lg:pb-12">
          <CodeHeadline words={WORDS} fill={fill} label={SENTENCE} className="w-full" />

          <p className="rise mt-4 max-w-[560px] text-[16px] leading-6 text-ink/80 [animation-delay:600ms]">
            $PNTH is the index of Ascend. Buys grow a locked basket of its top coins for stakers; sells burn supply.{" "}
            <span className="whitespace-nowrap rounded-md bg-ink/5 px-1.5 py-0.5 font-[450] text-ink">No owner. Rules locked.</span>
          </p>

          <div className="rise mt-6 flex w-full flex-col gap-3 [animation-delay:750ms] sm:w-auto sm:flex-row">
            <a href="#" className="btn-ink inline-flex h-10 items-center justify-center rounded-[10px] px-4 text-[14px] font-[450] sm:h-9">
              Buy $PNTH
            </a>
            <a href="#" className="inline-flex h-10 items-center justify-center rounded-[10px] bg-ink/5 px-4 text-[14px] font-[450] transition-colors hover:bg-ink/10 sm:h-9">
              See the basket
            </a>
          </div>

          {/* The Touch: a human hand and an uploaded one, reaching. Spans the full column width. */}
          <CodeTouch className="-mx-4 mt-12 w-[calc(100%+2rem)]" />
        </div>
      </section>

      <IndexSection />
    </main>
  );
}
