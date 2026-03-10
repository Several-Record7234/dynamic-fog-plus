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

/** Last seen discard-undo timestamp */
let lastDiscardTimestamp = 0;

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
    lastDiscardTimestamp = getMetadata<number>(
      metadata,
      getPluginId("persistence-discard-undo"),
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
    if (discardTs > lastDiscardTimestamp) {
      lastDiscardTimestamp = discardTs;
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
        lastDiscardTimestamp = getMetadata<number>(
          metadata,
          getPluginId("persistence-discard-undo"),
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
 * PRIMARY lights compute visibility directly; SECONDARY (environmental)
 * lights only contribute the portion visible from a PRIMARY light's LoS.
 */
async function handleItemsChange(items: Item[]): Promise<void> {
  if (!settings.enabled) return;

  const lightTokens = items.filter(
    (item) => getPluginId("light") in item.metadata
  );

  // Parse config for all light tokens and split by type
  const tokenConfigs: { token: Item; config: LightConfig; lightType: string }[] = [];
  for (const token of lightTokens) {
    const config = getMetadata<LightConfig>(
      token.metadata,
      getPluginId("light"),
      {}
    );
    tokenConfigs.push({
      token,
      config,
      lightType: config.lightType ?? "PRIMARY",
    });
  }

  const currentIds = new Set<string>();

  // Collect PRIMARY tokens that moved this cycle (we need their visibility
  // paths to intersect with SECONDARY lights)
  const movedPrimaryPaths: { position: Vector2; tracked: TrackedToken; visPath: import("canvaskit-wasm").Path }[] = [];

  // --- Pass 1: Process PRIMARY lights ---
  for (const { token, config, lightType } of tokenConfigs) {
    currentIds.add(token.id);
    if (lightType !== "PRIMARY") continue;
    if (settings.excludedTokens.includes(token.id)) continue;
    if (!token.visible) continue;

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
        lightType,
      };
      trackedTokens.set(token.id, newTracked);
      const visPath = await computeAndAccumulate(token.position, newTracked);
      if (visPath) movedPrimaryPaths.push({ position: token.position, tracked: newTracked, visPath });
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
        const visPath = await computeAndAccumulate(token.position, tracked);
        if (visPath) movedPrimaryPaths.push({ position: token.position, tracked, visPath });
      }
    }
  }

  // --- Pass 2: Process SECONDARY lights visible from moved PRIMARY tokens ---
  if (settings.persistDistantLights && movedPrimaryPaths.length > 0 && canvasKit) {
    for (const { token, config, lightType } of tokenConfigs) {
      if (lightType !== "SECONDARY") continue;
      if (settings.excludedTokens.includes(token.id)) continue;
      if (!token.visible) continue;

      // Track SECONDARY tokens so they're in the currentIds set
      currentIds.add(token.id);
      const attenuationRadius = config.attenuationRadius ?? cachedDpi * 6;
      const outerAngle = config.outerAngle ?? 360;
      const innerAngle = config.innerAngle ?? outerAngle;
      const lightRotation = token.rotation + (config.rotation ?? 0);
      const falloff = config.falloff ?? 1;

      // Ensure tracked entry exists for SECONDARY
      if (!trackedTokens.has(token.id)) {
        trackedTokens.set(token.id, {
          itemId: token.id,
          lastComputedPosition: { ...token.position },
          attenuationRadius,
          outerAngle,
          innerAngle,
          lightRotation,
          falloff,
          lightType,
        });
      }

      // Check if any PRIMARY light has unobstructed LoS to this SECONDARY.
      // There's no range limit — a PC can see a distant torch if no fog blocks
      // the line of sight.  We compute a visibility path from the PRIMARY that
      // reaches the far edge of the SECONDARY's light pool, so it can serve
      // both the containment check and the intersection.
      for (const primary of movedPrimaryPaths) {
        const dist = Math2.distance(primary.position, token.position);
        // Reach past the SECONDARY to the far edge of its illuminated area
        const losRadius = dist + attenuationRadius + cachedDpi;

        const losPath = computeVisibilityPath(
          canvasKit!,
          primary.position,
          losRadius,
          cachedFogItems,
          primary.tracked.outerAngle,
          primary.tracked.lightRotation
        );
        const canSee = losPath.contains(token.position.x, token.position.y);

        if (canSee) {
          // Intersect the SECONDARY's full visibility with the PRIMARY's LoS
          await computeSecondaryIntersection(token.position, {
            attenuationRadius,
            outerAngle,
            lightRotation,
            falloff,
          }, losPath);
          losPath.delete();
          break; // One PRIMARY seeing it is enough to trigger
        }
        losPath.delete();
      }
    }
  }

  // Clean up PRIMARY visibility paths
  for (const { visPath } of movedPrimaryPaths) {
    visPath.delete();
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
 *
 * Returns the visibility SkPath (caller must delete) so PRIMARY callers can
 * reuse it for SECONDARY intersection checks.  Returns null on error or rejection.
 */
async function computeAndAccumulate(
  position: Vector2,
  tracked: TrackedToken
): Promise<import("canvaskit-wasm").Path | null> {
  if (!canvasKit) {
    console.warn("[Persistence] CanvasKit not available, skipping computation");
    return null;
  }

  const t0 = performance.now();

  // Scale radius so persistence stays inside the light's feathered edge,
  // then snap to the nearest grid cell boundary so cardinal points align.
  const radiusScale = tracked.falloff <= 0.5 ? 0.90 : 0.80;
  const scaledRadius = tracked.attenuationRadius * radiusScale;
  const persistenceRadius = Math.round(scaledRadius / cachedDpi) * cachedDpi;

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

  const t2 = performance.now();

  if (accResult.status === "rejected") {
    visPath.delete();
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
    return null;
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

  // Return the visibility path for SECONDARY intersection (caller owns it)
  return visPath;
}

/**
 * Compute a SECONDARY (environmental) light's visibility, intersect it with
 * a PRIMARY light's full line-of-sight path, and accumulate the overlap.
 * The PRIMARY LoS path should extend far enough to cover the SECONDARY's
 * entire illuminated area, so the full pool of a distant torch is persisted
 * when the PC can see it.
 */
async function computeSecondaryIntersection(
  secondaryPosition: Vector2,
  secondaryConfig: {
    attenuationRadius: number;
    outerAngle: number;
    lightRotation: number;
    falloff: number;
  },
  primaryVisPath: import("canvaskit-wasm").Path
): Promise<void> {
  if (!canvasKit) return;

  const radiusScale = secondaryConfig.falloff <= 0.5 ? 0.90 : 0.80;
  const scaledRadius = secondaryConfig.attenuationRadius * radiusScale;
  const persistenceRadius = Math.round(scaledRadius / cachedDpi) * cachedDpi;

  // Compute what the SECONDARY light can see on its own
  const secondaryVisPath = computeVisibilityPath(
    canvasKit,
    secondaryPosition,
    persistenceRadius,
    cachedFogItems,
    secondaryConfig.outerAngle,
    secondaryConfig.lightRotation
  );

  // Intersect with PRIMARY's visibility — only the overlapping sliver survives
  const intersected = secondaryVisPath.copy();
  const ok = intersected.op(primaryVisPath, canvasKit.PathOp.Intersect);

  secondaryVisPath.delete();

  if (!ok || intersected.isEmpty()) {
    intersected.delete();
    return;
  }

  // Accumulate the intersected sliver
  const accResult = accumulateVisibilityPath(intersected);
  intersected.delete();

  if (accResult.status === "rejected") return;

  // Write updated shape
  const commands = getAccumulatedPathCommands();
  if (commands && commands.length > 0) {
    await writePersistenceFogItem(commands, settings.revealOpacity);
  }
}
