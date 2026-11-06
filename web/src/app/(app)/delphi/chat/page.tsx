import type { Metadata, Viewport } from "next";
import { DelphiChat } from "@/components/delphi-chat/delphi-chat";
import { elysium } from "@/lib/chain/config";
import { readDelphi, type Delphi, type Verdict } from "@/lib/delphi";

export const metadata: Metadata = {
  title: "Ask DELPHI · PANTHEON",
  description: "Ask DELPHI about any coin on Ascend, Kalos and PerpMe. She answers only from what she found on-chain, with the transactions behind it.",
};

export const viewport: Viewport = {
  // The phone's browser bar in the page's paper, and on Android the keyboard pushes the composer up
  // instead of covering it (iOS does this on its own).
  themeColor: "#f9f9f9",
  interactiveWidget: "resizes-content",
};

/** The busiest coin with a written report and this verdict, to suggest as a first question. */
function busiest(data: Delphi | null, verdict: Verdict) {
  return data?.coins
    .filter((c) => c.verdict === verdict && c.symbol && data.explained[c.token.toLowerCase()])
    .sort((a, b) => b.trades - a.trades)[0]?.symbol;
}

// Inside the app frame: the frame's bar on top (and its tab bar on a phone), and under it DELPHI and the
// conversation filling the rest of the screen.
export default async function Page() {
  const data = await readDelphi();
  const flagged = busiest(data, "FLAG");
  const watch = busiest(data, "WATCH");
  const clean = busiest(data, "CLEAN");
  const suggestions = [
    flagged && `Why is ${flagged} flagged?`,
    clean ? `Is ${clean} clean?` : watch && `Why is ${watch} on watch?`,
    "Which coins are flagged?",
  ].filter((q): q is string => !!q);
  return <DelphiChat framed explorer={data?.explorer ?? elysium.blockExplorers.default.url} suggestions={suggestions} />;
}
