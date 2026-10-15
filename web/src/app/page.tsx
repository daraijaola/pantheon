import Link from "next/link";
import { Basket } from "@/components/basket/basket";
import { CodeHeadline } from "@/components/code-type/code-headline";
import { CodeRain } from "@/components/code-type/code-rain";
import { CodeTouch } from "@/components/code-type/code-touch";
import { HowItWorks } from "@/components/how-it-works/how-it-works";
import { SiteShell } from "@/components/site-shell";
import { WhatYouGet } from "@/components/what-you-get/what-you-get";
import type { HeadlineWord } from "@/components/code-type/layout";
import { packCode, readOurCode } from "@/lib/our-code";

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

// Clear around the heading (radial) and fade out before the hands (linear); both masks must pass.
const RAIN_MASK =
  "radial-gradient(ellipse 60% 40% at 50% 34%, transparent 0%, transparent 30%, #000 88%), linear-gradient(to bottom, #000 0%, #000 45%, transparent 66%)";

export default async function Home() {
  const code = await readOurCode();
  const fill = packCode(code);

  return (
    <SiteShell>
      <main>
        <section className="relative overflow-hidden border-b border-rule">
          {/* Falling code stays inside the frame, like Firecrawl keeps its decoration inside the column. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-[min(1112px,calc(100%-32px))] -translate-x-1/2 overflow-hidden">
            <CodeRain
              source={code}
              className="absolute inset-0"
              style={{
                maskImage: RAIN_MASK,
                WebkitMaskImage: RAIN_MASK,
                maskComposite: "intersect",
                WebkitMaskComposite: "source-in",
              }}
            />
          </div>

          {/* Firecrawl's rhythm: heading where theirs sits (198px under the header), then sub 16 · buttons 24. */}
          <div className="relative mx-auto flex w-[min(1112px,calc(100%-32px))] flex-col items-center px-4 pt-24 pb-10 text-center lg:pt-[198px] lg:pb-12">
            <CodeHeadline words={WORDS} fill={fill} label={SENTENCE} className="w-full" />

            <p className="rise mt-4 max-w-[560px] text-[16px] leading-6 text-ink/80 [animation-delay:600ms]">
              $PNTH is the index of Ascend. Buys grow a locked basket of its top coins for stakers; sells burn supply.{" "}
              <span className="whitespace-nowrap rounded-md bg-ink/5 px-1.5 py-0.5 font-[450] text-ink">Fees with no owner. Rules locked.</span>
            </p>

            <div className="rise mt-6 flex w-full flex-col gap-3 [animation-delay:750ms] sm:w-auto sm:flex-row">
              <Link href="/get" className="btn-ink inline-flex h-10 items-center justify-center rounded-[10px] px-4 text-[14px] font-[450] sm:h-9">
                Get $PNTH
              </Link>
              <a
                href="#basket"
                className="inline-flex h-10 items-center justify-center rounded-[10px] bg-ink/5 px-4 text-[14px] font-[450] transition-colors hover:bg-ink/10 sm:h-9"
              >
                See the basket
              </a>
            </div>

            {/* The Touch: a human hand and an uploaded one, reaching. Spans the full column width. */}
            <CodeTouch className="-mx-4 mt-12 w-[calc(100%+2rem)]" />
          </div>
        </section>

        <HowItWorks />
        <WhatYouGet />
        <Basket code={fill} />
      </main>
    </SiteShell>
  );
}
