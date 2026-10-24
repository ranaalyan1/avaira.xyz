import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/doto/400.css";
import "@fontsource/doto/700.css";
import "@fontsource/doto/900.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@/index.css";
import App from "@/App";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
