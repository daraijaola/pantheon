import type { Metadata } from "next";
import { Suspense } from "react";
import { CoinReport, NotPublished } from "@/components/delphi/delphi";
import { SiteShell } from "@/components/site-shell";
import { readDelphi } from "@/lib/delphi";

export const metadata: Metadata = {
  title: "Coin report · DELPHI · PANTHEON",
  description: "DELPHI's report on one Ascend coin, in plain words, with the transactions behind every claim.",
};

async function Report({ token }: { token: string }) {
  const data = await readDelphi();
  return data ? <CoinReport data={data} token={token} /> : <NotPublished />;
}

export default function Page({ params }: PageProps<"/delphi/[token]">) {
  return (
    <SiteShell quiet>
      <Suspense>{params.then(({ token }) => <Report token={token} />)}</Suspense>
    </SiteShell>
  );
}
