import React from "react";
import ReactDOM from "react-dom/client";
// Fonts are self-hosted woff2 declared once in public/index.html (with
// preloads), shared by the static pre-render and the app — importing the
// @fontsource CSS here as well would download every face a second time
// under a different hashed URL.
import "@/index.css";
import App from "@/App";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
