import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import source from "../section3/code.sol.txt?raw";
import { Footer } from "../footer/Footer";
import { SiteHeader } from "../menu/SiteHeader";
import { COVENANT, PASSPORT, TRIALS } from "./content";
import { FeaturePage } from "./FeaturePage";
import { Terms } from "./Terms";

// One lab page for all the menu's pages: ?p=passport | trials | covenant | terms
const code = source
  .slice(Math.max(0, source.indexOf("contract ")))
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("")
  .replace(/\s+/g, "");
const which = new URLSearchParams(location.search).get("p") ?? "passport";
const PAGES = { passport: PASSPORT, trials: TRIALS, covenant: COVENANT };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SiteHeader code={code} />
    {which === "terms" ? <Terms /> : <FeaturePage page={PAGES[which as keyof typeof PAGES] ?? PASSPORT} />}
    <Footer code={code} />
  </StrictMode>,
);
