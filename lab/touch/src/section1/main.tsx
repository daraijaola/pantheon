import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HowItWorks } from "./HowItWorks";
import { WhatYouGet } from "../section2/WhatYouGet";

// Both sections together, in page order, so the rhythm between them can be judged.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ height: 40 }} />
    <HowItWorks />
    <WhatYouGet />
  </StrictMode>,
);
