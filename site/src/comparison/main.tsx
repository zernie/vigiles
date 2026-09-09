import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { ComparisonPage } from "./ComparisonPage";

/** MPA entry for /comparison — one static HTML page, no router (see gen-check-pages.ts). */
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ComparisonPage />
    </StrictMode>,
  );
}
