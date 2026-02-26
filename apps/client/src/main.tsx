import { Suspense, StrictMode, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const App = lazy(() => import("./App"));
const UiOptionsPreview = lazy(() =>
  import("./ui-options-preview").then((module) => ({
    default: module.UiOptionsPreview
  }))
);

const params = new URLSearchParams(window.location.search);
const isUiPreview = params.get("preview") === "ui";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<main className="auth-shell"><section className="auth-card"><p>Loading...</p></section></main>}>
      {isUiPreview ? <UiOptionsPreview /> : <App />}
    </Suspense>
  </StrictMode>
);
