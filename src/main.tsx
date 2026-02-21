/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { App } from "./App";
import { store } from "./app/store";
import { ensureStorageReady } from "./lib/appDataStorage";
import { isElectrobun } from "./electrobun/env";
import { initElectrobunRpc } from "./electrobun/renderer";

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>
);

// If we're running inside Electrobun, initialize the renderer RPC bridge early.
initElectrobunRpc();
if (isElectrobun()) {
  // Runtime marker used for Electrobun-only styling differences.
  document.documentElement.classList.add("runtime-electrobun");
}

async function bootstrap() {
  // Ensure app data storage is ready before first read (loads from backend when available)
  await ensureStorageReady();
  if (import.meta.hot) {
    const root = (import.meta.hot.data.root ??= createRoot(elem));
    root.render(app);
  } else {
    createRoot(elem).render(app);
  }
}

void bootstrap();
