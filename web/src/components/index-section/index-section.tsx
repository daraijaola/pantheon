import { SceneCanvas } from "./scene-canvas";

// Section 01 · The Index. One idea per cell, plain words, round numbers; the full math lives in the rules.
const CELLS = [
  { kind: "split", lead: "Every trade pays 1%.", rest: "Half goes to Ascend, half to PANTHEON." },
  { kind: "basket", lead: "Buys fill the basket.", rest: "Our half buys Ascend's 10 best coins, locked for stakers." },
  { kind: "burn", lead: "Sells burn PNTH.", rest: "Our half of every sell is destroyed. Fewer PNTH, forever." },
] as const;

export function IndexSection() {
  return (
    <section id="index" className="relative mx-auto w-[min(1112px,calc(100%-32px))]">
      {/* Chapter band, like Firecrawl's [ 01 / 07 ] · MAIN FEATURES. */}
      <div className="relative flex h-16 items-center border-b border-rule pl-6 font-code text-[12px] text-ink/40">
        <span aria-hidden="true" className="absolute top-[26px] -left-px h-3 w-0.5 bg-ink" />
        <span>
          [ <b className="font-medium text-ink">01</b> / 05 ] · THE INDEX
        </span>
      </div>

      <header className="px-6 pt-16 pb-12 text-center lg:pt-[72px] lg:pb-14">
        <p className="text-[13px] font-[450] text-ink/80">
          <span className="mr-1 text-ink/20">{"//"}</span> How it works <span className="ml-1 text-ink/20">{"\\\\"}</span>
        </p>
        <h2 className="mt-3.5 text-[36px] leading-10 font-medium tracking-[-0.36px] lg:text-[52px] lg:leading-[56px] lg:tracking-[-0.52px]">
          Buys build the basket.
          <br />
          <span className="text-ink/40">Sells burn the supply.</span>
        </h2>
        <p className="mx-auto mt-4 max-w-[520px] text-[16px] leading-6 text-ink/80">
          Every PNTH trade pays a small fee. Here is where it goes.
        </p>
      </header>

      <div className="grid border-t border-rule md:grid-cols-3">
        {CELLS.map((c) => (
          <article key={c.kind} className="border-b border-rule px-8 pt-8 pb-9 md:border-r md:border-b-0 md:last:border-r-0">
            <SceneCanvas kind={c.kind} className="mx-auto mb-7 block" />
            <p className="max-w-[290px] text-[16px] leading-6 text-ink/65">
              <b className="font-medium text-ink">{c.lead}</b> {c.rest}
            </p>
          </article>
        ))}
      </div>

      <div className="flex flex-col gap-3 border-y border-rule px-8 py-[22px] sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[16px] text-ink/65">
          <b className="font-medium text-ink">No one can change these rules.</b> Not even us.
        </p>
        <a href="#" className="group text-[14px] font-medium text-ink">
          Read the rules{" "}
          <span aria-hidden="true" className="inline-block transition-transform group-hover:translate-x-0.5">
            ›
          </span>
        </a>
      </div>
    </section>
  );
}
