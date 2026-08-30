import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BeautioApp } from "./app/BeautioApp.tsx";
import { I18nProvider } from "./i18n.tsx";
import "./styles/index.css";

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) {
  throw new Error("Beautio app root is missing.");
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <BeautioApp />
    </I18nProvider>
  </StrictMode>,
);
