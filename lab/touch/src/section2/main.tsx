import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { WhatYouGet } from "./WhatYouGet";

function Lab() {
  const [logos, setLogos] = useState<"mono" | "color">(() => (new URLSearchParams(location.search).get("logos") === "color" ? "color" : "mono"));
  return (
    <>
      <div style={{ height: 40 }} />
      <WhatYouGet logos={logos} />
      <div className="lab-bar">
        <span style={{ padding: "6px 8px", color: "#17171780" }}>logos</span>
        <button aria-pressed={logos === "mono"} onClick={() => setLogos("mono")}>black & white</button>
        <button aria-pressed={logos === "color"} onClick={() => setLogos("color")}>brand colour</button>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
);
