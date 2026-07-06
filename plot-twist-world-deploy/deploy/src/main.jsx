import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { installStorage, MULTIPLAYER } from "./storage.js";
import PlotTwistWorld from "./PlotTwistWorld.jsx";

installStorage(); // must run before the game touches window.storage
console.info(`Plot Twist: World Deed — ${MULTIPLAYER ? "multiplayer (Supabase)" : "single-player (localStorage)"} mode`);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PlotTwistWorld />
  </React.StrictMode>
);
