import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installGlobalLogHandlers, logEvent } from "./logger";
import "./styles.css";

installGlobalLogHandlers();
logEvent("info", "app.bootstrap", {
  href: window.location.href,
  userAgent: navigator.userAgent,
  secureContext: window.isSecureContext,
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
