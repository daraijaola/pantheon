import type { Metadata } from "next";
import { Suspense } from "react";
import { TRIALS } from "@/components/feature-page/content";
import { FeaturePage } from "@/components/feature-page/feature-page";
import { SiteShell } from "@/components/site-shell";
import { readTrialRound } from "@/lib/trials-server";
import { roundDate, trialsAction } from "@/lib/trials";
import a from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "The Trials · PANTHEON", description: TRIALS.sub };

async function TrialsPage() {
  const round = await readTrialRound();
  return <FeaturePage page={{
    ...TRIALS,
    discloseDetails: true,
    actions: [{ label: trialsAction(round), href: "/trials/vote", primary: true }],
    ...(round ? { example: false, diagram: <section className={a.cell} aria-label="Current round">
      <h2 className={a.h2}>Round {round.round} {round.status === "closed" ? "results" : round.status}</h2>
      <p className={a.hint}>Opens {roundDate(round.opensAt)}<br />Closes {roundDate(round.closesAt)}</p>
      <p>{round.ballots} {round.ballots === 1 ? "ballot" : "ballots"}{round.status === "open" ? " so far" : " counted"}</p>
      <ol>{round.leaders.map((token) => <li key={token}>{round.candidates.find((c) => c.token.toLowerCase() === token.toLowerCase())?.symbol ?? token.slice(0, 8)} · {round.candidates.find((c) => c.token.toLowerCase() === token.toLowerCase())?.votes ?? 0} votes</li>)}</ol>
      {round.status === "closed" && <p className={a.hint}>{round.nextOpensAt ? `Next round opens ${roundDate(round.nextOpensAt)}` : "Next round opens soon"}</p>}
    </section> } : {}),
  }} />;
}

export default function Page() {
  return (
    <SiteShell>
      <Suspense><TrialsPage /></Suspense>
    </SiteShell>
  );
}
