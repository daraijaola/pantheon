import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Basket } from "../section3/Basket";
import source from "../section3/code.sol.txt?raw";
import { SiteHeader } from "./SiteHeader";

// The header over a page, so the panel, the scrim and the sticky bar can be judged in place.
const code = source
  .slice(Math.max(0, source.indexOf("contract ")))
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("")
  .replace(/\s+/g, "");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SiteHeader code={code} />
    <Basket code={code} />
  </StrictMode>,
);
