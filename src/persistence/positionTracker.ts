import OBR, {
  Item,
  Vector2,
  Math2,
} from "@owlbear-rodeo/sdk";
import type { CanvasKit } from "canvaskit-wasm";
import { getPluginId } from "../util/getPluginId";
import { getMetadata } from "../util/getMetadata";
import type { LightConfig } from "../types/LightConfig";
import type { TrackedToken, PersistenceSettings } from "./types";
import { DEFAULT_PERSISTENCE_SETTINGS } from "./types";
import { computeVisibilityPath } from "./visibilityCanvasKit";
import {
  initAccumulator,
  accumulateVisibilityPath,
  getAccumulatedPathCommands,
  getTotalVertexCount,
  resetAccumulator,
  restoreFromPathCommands,
} from "./polygonAccumulator";
import { writePersistenceFogItem, removePersistenceFogItem, readPersistenceFogItem, updatePersistenceOpacity } from "./fogWriter";
import { drawDebugShapes, removeDebugShapes } from "./debugVisualize";

/** Map of token item IDs to their tracked state */
const trackedTokens = new Map<string, TrackedToken>();

/** Subscriptions to clean up */
let unsubscribes: VoidFunction[] = [];

/** Current persistence settings */
let settings: PersistenceSettings = { ...DEFAULT_PERSISTENCE_SETTINGS };

/** Cached DPI value */
let cachedDpi = 150;

/** Last seen reset timestamp (to detect reset signals from the action UI) */
let lastResetTimestamp = 0;

/** Last seen undo-reset timestamp */
let lastUndoResetTimestamp = 0;

/** Saved path commands for undo (cleared after expiry or undo) */
let savedCommandsForUndo: import("@owlbear-rodeo/sdk").PathCommand[] | null = null;

/** Whether debug visualization is active */
let debugVis = false;

/** Cached CanvasKit instance for path boolean operations */
let canvasKit: CanvasKit | null = null;

/**
 * Cached FOG-layer items from the scene.
 * Updated via OBR.scene.items.onChange.  These are the filled fog shapes
 * that the CanvasKit visibility computation subtracts from the light circle.
 */
let cachedFogItems: Item[] = [];

/**
 * Initialize the position tracker.
 * Only runs on the GM's client to avoid write conflicts — every connected
 * client runs the background page, but only one should own the persistence
 * fog item and accumulated polygon state.
 *
 * @param CK - The CanvasKit instance (already loaded by the background page)
 */
export async function initPositionTracker(CK: CanvasKit): Promise<void> {
  console.log("[Persistence] initPositionTracker called");
  canvasKit = CK;
  initAccumulator(CK);

  const role = await OBR.player.getRole();
  console.log(`[Persistence] Player role: ${role}`);
  if (role !== "GM") return;

  // Restore accumulated state from existing persistence fog item
  const existingCommands = await readPersistenceFogItem();
  if (existingCommands) {
    restoreFromPathCommands(existingCommands);
    console.log(`[Persistence] Restored existing persistence geometry (${existingCommands.length} commands)`);
  }

  // Get initial DPI
  OBR.scene.grid.getDpi().then((dpi) => {
    cachedDpi = dpi;
  });

  // Load persistence settings from scene metadata
  OBR.scene.getMetadata().then((metadata) => {
    settings = getMetadata<PersistenceSettings>(
      metadata,
      getPluginId("persistence-settings"),
      DEFAULT_PERSISTENCE_SETTINGS
    );
    lastResetTimestamp = getMetadata<number>(
      metadata,
      getPluginId("persistence-reset"),
      0
    );
    lastUndoResetTimestamp = getMetadata<number>(
      metadata,
      getPluginId("persistence-undo-reset"),
      0
    );
  });

  // Subscribe to scene item changes
  const unsubItems = OBR.scene.items.onChange((items) => {
    cachedFogItems = items.filter((i) => i.layer === "FOG");
    handleItemsChange(items);
  });

  // Seed the fog item cache
  OBR.scene.items.getItems().then((items) => {
    cachedFogItems = items.filter((i) => i.layer === "FOG");
    console.log(
      `[Persistence] Initial FOG item cache: ${cachedFogItems.length} items`
    );
  });

  // Subscribe to scene metadata changes (settings updates and reset signals)
  const unsubMeta = OBR.scene.onMetadataChange((metadata) => {
    const prevOpacity = settings.revealOpacity;
    settings = getMetadata<PersistenceSettings>(
      metadata,
      getPluginId("persistence-settings"),
      DEFAULT_PERSISTENCE_SETTINGS
    );

    // Apply opacity change immediately to existing fog item
    if (settings.revealOpacity !== prevOpacity) {
      updatePersistenceOpacity(settings.revealOpacity);
    }

    // Check for reset signal
    const resetTs = getMetadata<number>(
      metadata,
      getPluginId("persistence-reset"),
      0
    );
    if (resetTs > lastResetTimestamp) {
      lastResetTimestamp = resetTs;
      resetPersistence();
    }

    // Check for undo-reset signal
    const undoResetTs = getMetadata<number>(
      metadata,
      getPluginId("persistence-undo-reset"),
      0
    );
    if (undoResetTs > lastUndoResetTimestamp) {
      lastUndoResetTimestamp = undoResetTs;
      undoReset();
    }

    // Check for discard-undo signal (undo window expired)
    const discardTs = getMetadata<number>(
      metadata,
      getPluginId("persistence-discard-undo"),
      0
    );
    if (discardTs > 0) {
      discardUndoSnapshot();
    }

    // Check for debug vis toggle
    const newDebug = getMetadata<boolean>(
      metadata,
      getPluginId("persistence-debug"),
      false
    );
    if (newDebug !== debugVis) {
      debugVis = newDebug;
      if (!debugVis) removeDebugShapes();
    }
  });

  // Subscribe to scene ready changes (clear on scene switch)
  const unsubReady = OBR.scene.onReadyChange((ready) => {
    if (!ready) {
      trackedTokens.clear();
      cachedFogItems = [];
      resetAccumulator();
    } else {
      // Reload settings and DPI on new scene
      OBR.scene.grid.getDpi().then((dpi) => {
        cachedDpi = dpi;
      });
      OBR.scene.getMetadata().then((metadata) => {
        settings = getMetadata<PersistenceSettings>(
          metadata,
          getPluginId("persistence-settings"),
          DEFAULT_PERSISTENCE_SETTINGS
        );
        lastResetTimestamp = getMetadata<number>(
          metadata,
          getPluginId("persistence-reset"),
          0
        );
        lastUndoResetTimestamp = getMetadata<number>(
          metadata,
          getPluginId("persistence-undo-reset"),
          0
        );
      });
    }
  });

  unsubscribes = [unsubItems, unsubMeta, unsubReady];
}

/** Clean up subscriptions */
export function destroyPositionTracker(): void {
  for (const unsub of unsubscribes) {
    unsub();
  }
  unsubscribes = [];
  trackedTokens.clear();
  cachedFogItems = [];
  resetAccumulator();
  canvasKit = null;
}

/** Update persistence settings (called from GM controls) */
export function updatePersistenceSettings(
  newSettings: Partial<PersistenceSettings>
): void {
  settings = { ...settings, ...newSettings };
  OBR.scene.setMetadata({
    [getPluginId("persistence-settings")]: settings,
  });
}

/** Get current settings (for UI) */
export function getPersistenceSettings(): PersistenceSettings {
  return { ...settings };
}

/** Reset all accumulated persistence data, saving a snapshot for undo */
export async function resetPersistence(): Promise<void> {
  // Snapshot current commands before clearing, so undo can restore them
  savedCommandsForUndo = getAccumulatedPathCommands();
  resetAccumulator();
  trackedTokens.clear();
  await removePersistenceFogItem();
}

/** Undo the most recent reset by restoring the saved snapshot */
async function undoReset(): Promise<void> {
  if (!savedCommandsForUndo || savedCommandsForUndo.length === 0) return;
  restoreFromPathCommands(savedCommandsForUndo);
  await writePersistenceFogItem(savedCommandsForUndo, settings.revealOpacity);
  savedCommandsForUndo = null;
  // Publish updated perf/vertex count
  const vertexCount = getTotalVertexCount();
  await OBR.scene.setMetadata({
    [getPluginId("persistence-vertex-count")]: vertexCount,
    [getPluginId("persistence-perf")]: {
      totalMs: 0,
      visMs: 0,
      unionMs: 0,
      wallCount: cachedFogItems.length,
      vertexCount,
      status: "ok" as const,
    },
  });
}

/** Discard saved undo snapshot (called when undo window expires) */
function discardUndoSnapshot(): void {
  savedCommandsForUndo = null;
}

/**
 * Handle scene item changes.
 * Identify light-bearing tokens and track their movement.
 */
async function handleItemsChange(items: Item[]): Promise<void> {
  if (!settings.enabled) return;

  const lightTokens = items.filter(
    (item) => getPluginId("light") in item.metadata
  );

  const currentIds = new Set<string>();
  for (const token of lightTokens) {
    currentIds.add(token.id);

    if (settings.excludedTokens.includes(token.id)) continue;

    // Skip hidden tokens — their light is disabled while hidden
    if (!token.visible) continue;

    const config = getMetadata<LightConfig>(
      token.metadata,
      getPluginId("light"),
      {}
    );

    const attenuationRadius = config.attenuationRadius ?? cachedDpi * 6;
    const outerAngle = config.outerAngle ?? 360;
    const innerAngle = config.innerAngle ?? outerAngle;
    const lightRotation = token.rotation + (config.rotation ?? 0);
    const falloff = config.falloff ?? 1;

    const tracked = trackedTokens.get(token.id);
    if (!tracked) {
      const newTracked: TrackedToken = {
        itemId: token.id,
        lastComputedPosition: { ...token.position },
        attenuationRadius,
        outerAngle,
        innerAngle,
        lightRotation,
        falloff,
      };
      trackedTokens.set(token.id, newTracked);
      await computeAndAccumulate(token.position, newTracked);
    } else {
      const threshold = cachedDpi / 2;
      const dist = Math2.distance(token.position, tracked.lastComputedPosition);

      if (dist >= threshold) {
        tracked.lastComputedPosition = { ...token.position };
        tracked.attenuationRadius = attenuationRadius;
        tracked.outerAngle = outerAngle;
        tracked.innerAngle = innerAngle;
        tracked.lightRotation = lightRotation;
        tracked.falloff = falloff;
        await computeAndAccumulate(token.position, tracked);
      }
    }
  }

  for (const id of trackedTokens.keys()) {
    if (!currentIds.has(id)) {
      trackedTokens.delete(id);
    }
  }
}

/**
 * Compute visibility at a position and accumulate into the persistence path.
 * Uses CanvasKit path-boolean operations for both visibility and accumulation,
 * which correctly preserves holes where fog shapes were subtracted.
 */
async function computeAndAccumulate(
  position: Vector2,
  tracked: TrackedToken
): Promise<void> {
  if (!canvasKit) {
    console.warn("[Persistence] CanvasKit not available, skipping computation");
    return;
  }

  const t0 = performance.now();

  // Scale radius so persistence stays inside the light's feathered edge.
  // Hard-edge lights (falloff <= 0.5) have a sharper boundary so 90% suffices.
  // Soft-edge lights (falloff >= 1) fade out more gradually, needing a tighter cut.
  const radiusScale = tracked.falloff <= 0.5 ? 0.90 : 0.80;
  const persistenceRadius = tracked.attenuationRadius * radiusScale;

  const visPath = computeVisibilityPath(
    canvasKit,
    position,
    persistenceRadius,
    cachedFogItems,
    tracked.outerAngle,
    tracked.lightRotation
  );

  const t1 = performance.now();

  // Draw debug shapes if enabled
  if (debugVis) {
    drawDebugShapes(
      canvasKit,
      position,
      tracked.attenuationRadius,
      cachedFogItems,
      tracked.outerAngle,
      tracked.lightRotation
    );
  }

  // Accumulate via CanvasKit PathOp.Union (preserves holes)
  const accResult = accumulateVisibilityPath(visPath);
  visPath.delete();

  const t2 = performance.now();

  if (accResult.status === "rejected") {
    await OBR.scene.setMetadata({
      [getPluginId("persistence-vertex-count")]: accResult.vertexCount,
      [getPluginId("persistence-perf")]: {
        totalMs: 0,
        visMs: 0,
        unionMs: 0,
        wallCount: cachedFogItems.length,
        vertexCount: accResult.vertexCount,
        status: "rejected",
      },
    });
    return;
  }

  // Write to the FOG layer
  const commands = getAccumulatedPathCommands();
  if (commands && commands.length > 0) {
    await writePersistenceFogItem(commands, settings.revealOpacity);
  }

  const totalMs = performance.now() - t0;
  const visMs = t1 - t0;
  const unionMs = t2 - t1;
  const vertexCount = getTotalVertexCount();

  await OBR.scene.setMetadata({
    [getPluginId("persistence-vertex-count")]: vertexCount,
    [getPluginId("persistence-perf")]: {
      totalMs: Math.round(totalMs * 100) / 100,
      visMs: Math.round(visMs * 100) / 100,
      unionMs: Math.round(unionMs * 100) / 100,
      wallCount: cachedFogItems.length,
      vertexCount,
      status: accResult.status,
    },
  });
}
