import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { UiOptionsPreview } from "./ui-options-preview";

const params = new URLSearchParams(window.location.search);
const isUiPreview = params.get("preview") === "ui";

createRoot(document.getElementById("root")!).render(<StrictMode>{isUiPreview ? <UiOptionsPreview /> : <App />}</StrictMode>);
