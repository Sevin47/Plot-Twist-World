import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { MULTIPLAYER } from "./storage.js";
import PlotTwistWorld from "./PlotTwistWorld.jsx";

console.info(`Plot Twist: World Deed — ${MULTIPLAYER ? "accounts + shared world (Supabase)" : "not configured — no Supabase credentials"}`);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PlotTwistWorld />
  </React.StrictMode>
);
