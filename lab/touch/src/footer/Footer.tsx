// The page footer, laid out on the same hairline grid as the rest of the page: who we are and
// where we launch, the links (pages that don't exist yet say "soon"), the fine print, and to
// close, the name itself in our code type, decrypting the first time it comes into view.

import { CodeHeadline } from "../code-type/code-headline";
import { CodeWordmark } from "../code-type/code-wordmark";
import f from "./footer.module.css";

const LINKS = {
  x: "https://x.com/pantheonindex",
  github: "https://github.com/daraijaola/pantheon",
  ascend: "https://ascendlaunch.xyz",
  elysium: "https://elysiumeco.xyz",
};

type Item = { label: string; href?: string }; // no href yet = "soon"
const COLUMNS: { title: string; items: Item[] }[] = [
  {
    title: "PANTHEON",
    items: [
      { label: "How it works", href: "/#how-it-works" },
      { label: "The basket", href: "/#basket" },
      { label: "Stake PNTH", href: "/stake" },
      { label: "Terms of use", href: "/terms" },
    ],
  },
  {
    title: "Features",
    items: [
      { label: "HYPE Passport", href: "/passport" },
      { label: "The Trials", href: "/trials" },
      { label: "Covenant", href: "/covenant" },
      { label: "DELPHI", href: "/delphi" },
    ],
  },
  {
    title: "Developers",
    items: [{ label: "GitHub", href: LINKS.github }, { label: "Contracts" }, { label: "Security" }],
  },
];

const external = (href: string) => (href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {});

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const WORDMARK = [{ text: "PANTHEON" }];

export function Footer({ code, quiet = false }: { code: string; quiet?: boolean }) {
  return (
    <footer className={f.footer}>
      <div className={f.grid}>
        <div className={`${f.cell} ${f.brand}`}>
          <CodeWordmark text="PANTHEON" module={2.2} />
          <p className={f.tagline}>
            The best of Ascend,
            <br />
            in one token.
          </p>
          <p className={f.status}>
            <span className={f.dot} aria-hidden="true" />
            No owner. Rules locked.
          </p>
        </div>
        <a className={`${f.cell} ${f.partner}`} href={LINKS.ascend} {...external(LINKS.ascend)}>
          <span className={f.label}>Launching on</span>
          <img src="/brand/ascend-wordmark-light.png" alt="Ascend" className={f.ink} style={{ height: 20 }} />
          <span className={f.arrow} aria-hidden="true">
            ↗
          </span>
        </a>
        <a className={`${f.cell} ${f.partner}`} href={LINKS.elysium} {...external(LINKS.elysium)}>
          <span className={f.label}>Built on</span>
          <img src="/brand/elysium-wordmark-dark.svg" alt="Elysium" className={f.ink} style={{ height: 22 }} />
          <span className={f.arrow} aria-hidden="true">
            ↗
          </span>
        </a>

        {COLUMNS.map((col) => (
          <nav key={col.title} className={f.col} aria-label={col.title}>
            <p className={f.colTitle}>{col.title}</p>
            <ul>
              {col.items.map((item) => (
                <li key={item.label}>
                  {item.href ? (
                    <a href={item.href} {...external(item.href)}>
                      {item.label}
                      {item.href.startsWith("http") && <span aria-hidden="true"> ↗</span>}
                    </a>
                  ) : (
                    <span className={f.soon}>
                      {item.label} <small>soon</small>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
        <a className={`${f.cell} ${f.follow}`} href={LINKS.x} {...external(LINKS.x)}>
          <XLogo />
          <span>
            <b>@pantheonindex</b>
            <span className={f.muted}>Launch news and the weekly vote.</span>
          </span>
          <span className={f.followCta}>Follow ↗</span>
        </a>

        <p className={`${f.cell} ${f.copy}`}>© 2026 PANTHEON</p>
        <p className={`${f.cell} ${f.notice}`}>
          PNTH is a crypto token. Its price can fall and you can lose what you put in. Nothing on this site is financial advice.
        </p>
      </div>

      {!quiet && (
        <div className={f.giant}>
          <CodeHeadline words={WORDMARK} fill={code} label="PANTHEON" maxCharW={9} maxHeightVh={0.3} density={2} startOnView decorative />
        </div>
      )}
    </footer>
  );
}
