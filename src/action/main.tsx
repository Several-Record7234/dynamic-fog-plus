import React from "react";
import ReactDOM from "react-dom/client";

import { PersistenceControls } from "./PersistenceControls";
import { PluginGate } from "../menu/util/PluginGate";
import { PluginThemeProvider } from "../menu/util/PluginThemeProvider";
import CssBaseline from "@mui/material/CssBaseline";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PluginGate>
      <PluginThemeProvider>
        <CssBaseline />
        <PersistenceControls />
      </PluginThemeProvider>
    </PluginGate>
  </React.StrictMode>
);
