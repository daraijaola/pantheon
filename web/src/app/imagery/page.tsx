// Style tile v0.1 (Pantheon-series look). Kept as the brand-imagery colour reference, not the site design.

const nav = ["Index", "Trials", "Passport", "Launch"];

const stats = [
  { label: "Basket value", value: 184206.42, decimals: 2, prefix: "$", delta: "+6.8% 7d", up: true },
  { label: "PNTH burned", value: 3481920, decimals: 0, prefix: "", delta: "+41,204 today", up: true },
  { label: "Passport holders", value: 1204, decimals: 0, prefix: "", delta: "+87 this week", up: true },
  { label: "Rules-locked coins", value: 37, decimals: 0, prefix: "", delta: "+5 this week", up: true },
];

const basket = [
  { rank: 1, ticker: "HELIOS", weight: 18.4, change: 4.2, locked: 2104331.08 },
  { rank: 2, ticker: "AETHER", weight: 15.2, change: -1.8, locked: 1882904.51 },
  { rank: 3, ticker: "NYX", weight: 12.7, change: 9.6, locked: 1240118.77 },
  { rank: 4, ticker: "ARGO", weight: 10.1, change: 0.4, locked: 988442.1 },
  { rank: 5, ticker: "THEMIS", weight: 8.6, change: -3.1, locked: 741006.93 },
];

const swatches = [
  { name: "void", hex: "#070D16", note: "page" },
  { name: "navy", hex: "#0B1A2A", note: "sections" },
  { name: "surface", hex: "#11263A", note: "cards" },
  { name: "line", hex: "#1A3550", note: "borders" },
  { name: "text", hex: "#EDEFF2", note: "primary" },
  { name: "text-2", hex: "#9FB0C2", note: "secondary" },
  { name: "muted", hex: "#5F7388", note: "labels" },
  { name: "teal", hex: "#22B8C9", note: "actions" },
  { name: "orange", hex: "#FF7A1A", note: "on-chain" },
  { name: "amber", hex: "#FFB000", note: "basket" },
  { name: "magenta", hex: "#FF2E88", note: "glitch only" },
  { name: "red", hex: "#D7263D", note: "errors" },
  { name: "green", hex: "#2BD48F", note: "success" },
];

// Full precision for tables and tooltips; compact (184.21K, 3.48M) where space is tight.
function full(n: number, decimals = 0) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function compact(n: number) {
  if (n < 10_000) return full(n);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function Wordmark() {
  return (
    <a href="#" className="glitch font-display text-[26px] font-extrabold leading-none tracking-[0.04em]">
      PANTHEON
    </a>
  );
}

function SectionHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-8">
      <p className="label">{eyebrow}</p>
      <h2 className="mt-2 font-display text-[32px] font-bold uppercase leading-none tracking-[-0.01em]">{title}</h2>
    </div>
  );
}

export default function StyleTile() {
  return (
    <main className="min-h-screen bg-void font-sans text-text [color-scheme:dark]">
      {/* Nav */}
      <header className="border-b border-line bg-void/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <Wordmark />
            <span className="hidden border-l border-line pl-4 label sm:inline">The index of Ascend</span>
          </div>
          <nav className="flex items-center gap-8">
            <ul className="hidden gap-8 text-[14px] text-text-2 md:flex">
              {nav.map((item) => (
                <li key={item}>
                  <a href="#" className="transition-colors hover:text-text">
                    {item}
                  </a>
                </li>
              ))}
            </ul>
            <button className="glitch h-10 rounded-sm bg-teal px-5 text-[14px] font-semibold text-void">
              Connect wallet
            </button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="scanlines border-b border-line bg-navy">
        <div className="mx-auto grid max-w-[1200px] gap-12 px-6 py-24 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <p className="label">Elysium testnet · Built for Ascend</p>
            <h1
              className="echo mt-5 font-display text-[56px] font-extrabold uppercase leading-[0.95] tracking-[-0.01em] sm:text-[72px]"
              data-text="The index of Ascend"
            >
              The index of Ascend
            </h1>
            <p className="mt-6 font-display text-[24px] font-bold uppercase tracking-[0.01em] text-text-2">
              Buys build the basket. <span className="text-orange">Sells burn the supply.</span>
            </p>
            <p className="mt-6 max-w-[520px] text-[16px] leading-relaxed text-text-2">
              Every $PNTH trade pays a fee that buys and locks the strongest coins on Ascend. Verified Hyperliquid holders
              choose who enters, every week.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <button className="glitch h-11 rounded-sm bg-teal px-6 text-[15px] font-semibold text-void">
                Stake $PNTH
              </button>
              <button className="h-11 rounded-sm border border-teal px-6 text-[15px] font-medium text-teal transition-colors hover:bg-teal/10">
                Read the rules
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-px self-end border border-line bg-line lg:col-span-5">
            {stats.map((s) => (
              <div key={s.label} className="flex flex-col bg-surface p-4 sm:p-6">
                <p className="label">{s.label}</p>
                {/* Pinned to the bottom so values line up even when a label wraps */}
                <div className="mt-auto pt-3">
                  <p className="num text-[24px] font-medium leading-none" title={s.prefix + full(s.value, s.decimals)}>
                    {s.prefix}
                    {compact(s.value)}
                  </p>
                  <p className={`num mt-3 text-[12px] ${s.up ? "text-green" : "text-red"}`}>{s.delta}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Basket */}
      <section className="mx-auto max-w-[1200px] px-6 py-20">
        <SectionHeader eyebrow="Live basket · sample data" title="Locked in the Pantheon" />
        <div className="overflow-x-auto border border-line">
          <table className="w-full text-left text-[14px]">
            <thead className="border-b border-line bg-surface">
              <tr>
                <th className="hidden px-5 py-3 label font-medium sm:table-cell">#</th>
                <th className="px-3 py-3 label font-medium sm:px-5">Coin</th>
                <th className="px-3 py-3 label font-medium sm:px-5">Weight</th>
                <th className="px-3 py-3 label font-medium text-right sm:px-5">24h</th>
                <th className="px-3 py-3 label font-medium text-right sm:px-5">Locked</th>
              </tr>
            </thead>
            <tbody>
              {basket.map((row) => (
                <tr key={row.ticker} className="border-b border-line last:border-0 hover:bg-line/40">
                  <td className="num hidden px-5 py-4 text-muted sm:table-cell">{String(row.rank).padStart(2, "0")}</td>
                  <td className="px-3 py-4 font-medium sm:px-5">${row.ticker}</td>
                  <td className="px-3 py-4 sm:px-5">
                    <div className="flex items-center gap-3">
                      <div className="hidden h-[3px] w-32 bg-line sm:block">
                        <div className="h-full bg-amber" style={{ width: `${(row.weight / 20) * 100}%` }} />
                      </div>
                      <span className="num text-text-2">{row.weight.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className={`num px-3 py-4 text-right sm:px-5 ${row.change >= 0 ? "text-green" : "text-red"}`}>
                    {row.change >= 0 ? "+" : ""}
                    {row.change.toFixed(1)}%
                  </td>
                  <td className="num px-3 py-4 text-right sm:px-5" title={full(row.locked, 2)}>
                    <span className="sm:hidden">{compact(row.locked)}</span>
                    <span className="hidden sm:inline">{full(row.locked, 2)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Design foundation */}
      <section className="border-t border-line bg-navy">
        <div className="mx-auto max-w-[1200px] px-6 py-20">
          <SectionHeader eyebrow="Design foundation v0.1" title="System" />

          {/* Colour */}
          <p className="label mb-4">Colour</p>
          <div className="grid grid-cols-2 gap-px border border-line bg-line md:grid-cols-7">
            {swatches.map((c) => (
              <div key={c.name} className="bg-void p-4">
                <div className="h-14 border border-line" style={{ backgroundColor: c.hex }} />
                <p className="mt-3 text-[13px] font-medium">{c.name}</p>
                <p className="num text-[12px] text-muted">{c.hex}</p>
                <p className="text-[12px] text-text-2">{c.note}</p>
              </div>
            ))}
            <div className="bg-void p-4">
              <div className="flex h-14 items-center justify-center border border-line">
                <span className="echo font-display text-[28px] font-extrabold uppercase leading-none" data-text="Pnth">
                  Pnth
                </span>
              </div>
              <p className="mt-3 text-[13px] font-medium">echo</p>
              <p className="num text-[12px] text-muted">orange 32%</p>
              <p className="text-[12px] text-text-2">hero only</p>
            </div>
          </div>

          {/* Type */}
          <div className="mt-14 grid gap-px border border-line bg-line lg:grid-cols-3">
            <div className="bg-void p-6">
              <p className="label">Display · Big Shoulders</p>
              <p className="mt-4 font-display text-[48px] font-extrabold uppercase leading-none">Pantheon</p>
              <p className="mt-2 font-display text-[24px] font-bold uppercase text-text-2">Headings &amp; big stats</p>
            </div>
            <div className="bg-void p-6">
              <p className="label">Body · Space Grotesk</p>
              <p className="mt-4 text-[20px] font-medium">Buys build the basket.</p>
              <p className="mt-2 text-[16px] leading-relaxed text-text-2">
                Calm, precise copy. Short sentences. The data does the talking.
              </p>
            </div>
            <div className="bg-void p-6">
              <p className="label">Data · JetBrains Mono</p>
              <p className="num mt-4 text-[24px]">1,240,118.77</p>
              <p className="num mt-2 text-[13px] text-text-2" title="0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9">
                0xE2f625…00d8E9
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="mt-14 grid gap-px border border-line bg-line lg:grid-cols-2">
            <div className="bg-void p-6">
              <p className="label mb-4">Buttons</p>
              <div className="flex flex-wrap gap-3">
                <button className="glitch h-10 rounded-sm bg-teal px-5 text-[14px] font-semibold text-void">Primary</button>
                <button className="h-10 rounded-sm border border-teal px-5 text-[14px] font-medium text-teal hover:bg-teal/10">
                  Secondary
                </button>
                <button className="h-10 rounded-sm border border-red px-5 text-[14px] font-medium text-red hover:bg-red/10">
                  Unstake
                </button>
                <button disabled className="h-10 cursor-not-allowed rounded-sm bg-line px-5 text-[14px] font-medium text-muted">
                  Disabled
                </button>
              </div>

              <p className="label mb-3 mt-8">Amount input</p>
              <div className="flex h-12 items-center rounded-sm border border-line bg-surface focus-within:border-teal">
                <input
                  aria-label="Amount of PNTH"
                  defaultValue="2,500.00"
                  className="num h-full flex-1 bg-transparent px-4 text-[18px] outline-none"
                />
                <span className="num px-3 text-[13px] text-text-2">PNTH</span>
                <button className="mr-2 h-8 rounded-sm border border-line px-3 text-[12px] font-medium text-teal hover:border-teal">
                  MAX
                </button>
              </div>
            </div>

            <div className="bg-void p-6">
              <p className="label mb-4">Badges</p>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-sm border border-teal/50 px-2.5 py-1 text-[12px] font-medium text-teal">
                  HYPE Passport · Tier 1
                </span>
                <span className="rounded-sm border border-amber/50 px-2.5 py-1 text-[12px] font-medium text-amber">
                  HYPE Passport · Tier 2
                </span>
                <span className="rounded-sm border border-orange/50 px-2.5 py-1 text-[12px] font-medium text-orange">
                  HYPE Passport · Tier 3
                </span>
                <span className="rounded-sm border border-line px-2.5 py-1 text-[12px] font-medium text-text-2">
                  Rules locked ✓
                </span>
              </div>

              <p className="label mb-3 mt-8">Transaction states</p>
              <ul className="space-y-2 text-[14px]">
                <li className="flex items-center justify-between rounded-sm border border-line bg-surface px-4 py-3">
                  <span className="flex items-center gap-3">
                    <span className="pulse h-2 w-2 rounded-full bg-teal" />
                    Staking 2,500 PNTH
                  </span>
                  <span className="num text-[12px] text-muted">pending</span>
                </li>
                <li className="flex items-center justify-between rounded-sm border border-line bg-surface px-4 py-3">
                  <span className="flex items-center gap-3">
                    <span className="h-2 w-2 rounded-full bg-green" />
                    Basket buy · 2 coins locked
                  </span>
                  <a href="#" className="num text-[12px] text-teal hover:underline">
                    0x7a3f…c41e ↗
                  </a>
                </li>
                <li className="flex items-center justify-between rounded-sm border border-line bg-surface px-4 py-3">
                  <span className="flex items-center gap-3">
                    <span className="h-2 w-2 rounded-full bg-red" />
                    Vote failed: Passport expired
                  </span>
                  <span className="num text-[12px] text-muted">retry</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-8">
          <span className="font-display text-[18px] font-extrabold tracking-[0.04em]">PANTHEON</span>
          <span className="num text-[12px] text-muted">style tile v0.1 · sample data</span>
        </div>
      </footer>
    </main>
  );
}
