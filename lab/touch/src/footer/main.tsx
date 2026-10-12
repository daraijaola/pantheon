import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Basket } from "../section3/Basket";
import source from "../section3/code.sol.txt?raw";
import { Footer } from "./Footer";

// The end of the page as it will read: the basket (03), then the footer.
const code = source
  .slice(Math.max(0, source.indexOf("contract ")))
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("")
  .replace(/\s+/g, "");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Basket code={code} />
    <Footer code={code} />
  </StrictMode>,
);
