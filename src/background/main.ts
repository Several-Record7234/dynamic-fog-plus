import OBR from "@owlbear-rodeo/sdk";
import CanvasKitInit from "canvaskit-wasm/bin/full/canvaskit";
import wasm from "canvaskit-wasm/bin/full/canvaskit.wasm?url";
import { createLightMenu } from "./createLightMenu";
import { createDoorMode } from "./createDoorMode";
import { Reconciler } from "./reconcile/Reconciler";
import { LightReactor } from "./reconcile/reactors/LightReactor";
import { SelfLightReactor } from "./reconcile/reactors/SelfLightReactor";
import { DoorReactor } from "./reconcile/reactors/DoorReactor";
import { WallReactor } from "./reconcile/reactors/WallReactor";
import { initOverlay } from "./overlay";
import { createLineMode } from "./createLineMode";
import { initPositionTracker, destroyPositionTracker } from "../persistence/positionTracker";
import { restoreAccumulator } from "../persistence/polygonAccumulator";
import { readPersistenceFogItem } from "../persistence/fogWriter";

async function waitUntilOBRReady() {
  return new Promise<void>((resolve) => {
    OBR.onReady(() => {
      resolve();
    });
  });
}

let reconciler: Reconciler | null = null;
async function init() {
  const CanvasKit = await CanvasKitInit({ locateFile: () => wasm });
  await waitUntilOBRReady();
  createLightMenu();
  createLineMode();
  createDoorMode(CanvasKit);
  reconciler = new Reconciler(CanvasKit);
  reconciler.register(new LightReactor(reconciler));
  reconciler.register(new SelfLightReactor(reconciler));
  reconciler.register(new DoorReactor(reconciler));
  reconciler.register(new WallReactor(reconciler));
  initOverlay(reconciler);

  // Defer persistence init until a scene is loaded.
  // OBR.onReady fires when the SDK connects, but scene APIs throw
  // "No scene found" if no scene is loaded yet.
  async function initPersistence() {
    const savedRings = await readPersistenceFogItem();
    if (savedRings) {
      restoreAccumulator(savedRings);
    }
    await initPositionTracker();
  }

  const sceneReady = await OBR.scene.isReady();
  if (sceneReady) {
    initPersistence().catch((err) =>
      console.error("[Persistence] Failed to initialize:", err)
    );
  }
  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      initPersistence().catch((err) =>
        console.error("[Persistence] Failed to initialize:", err)
      );
    }
  });
}

init();

// Clean up on HMR refresh
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    reconciler?.delete();
    destroyPositionTracker();
  });
}
