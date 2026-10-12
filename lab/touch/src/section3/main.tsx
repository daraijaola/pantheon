import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Basket } from "./Basket";
import source from "./code.sol.txt?raw";

// The site passes the same contract code the hero uses (comments dropped, whitespace removed).
const code = source
  .slice(Math.max(0, source.indexOf("contract ")))
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("")
  .replace(/\s+/g, "");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ maxWidth: 1112, margin: "0 auto", borderLeft: "1px solid #ebebeb", borderRight: "1px solid #ebebeb" }}>
      <div style={{ height: 40 }} />
      <Basket code={code} />
    </div>
  </StrictMode>,
);
