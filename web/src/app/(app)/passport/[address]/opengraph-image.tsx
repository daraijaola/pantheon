import { networkLabel } from "@/lib/network-copy";
import { ImageResponse } from "next/og";
import { isAddress } from "viem";
import { readPublicPassport } from "@/lib/passport-public";
import { TIER_NAMES } from "@/components/passport-book/view";

export const alt = "HYPE Passport public registry facts · PANTHEON";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  let status = "No passport yet";
  let view: Awaited<ReturnType<typeof readPublicPassport>> = null;
  let code = 200;
  if (!isAddress(address, { strict: false })) { status = "Invalid wallet address"; code = 400; }
  else {
    try { view = await readPublicPassport(address); status = view?.status ?? status; }
    catch { status = "Couldn't read this passport"; code = 503; }
  }
  return new ImageResponse(
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", padding: 64, background: "#f9f9f9", color: "#171717", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 25, letterSpacing: 3 }}><b>PANTHEON</b><span>HYPE PASSPORT</span></div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, marginTop: 36, padding: 40, borderRadius: 28, background: "#171717", color: "#f9f9f9" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24 }}><span>{isAddress(address, { strict: false }) ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Elysium registry"}</span><span>{status}</span></div>
        <div style={{ display: "flex", fontSize: 62, marginTop: 24 }}>{view ? `Tier ${view.tier} · ${TIER_NAMES[view.tier]}` : status}</div>
        {view && <div style={{ display: "flex", fontSize: 30, marginTop: 18 }}>{view.boost} boost · {view.stamps.length}/8 stamps</div>}
        {view && <div style={{ display: "flex", fontSize: 21, marginTop: 24 }}>{view.stamps.join(" · ") || "No stamps recorded"}</div>}
      </div>
      <div style={{ display: "flex", marginTop: 24, fontSize: 19 }}>Public on-chain facts · {networkLabel} · pantheonindex.com</div>
    </div>, { ...size, status: code, headers: { "Cache-Control": "no-store" } },
  );
}
