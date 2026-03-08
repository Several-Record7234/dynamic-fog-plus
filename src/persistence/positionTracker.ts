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
import { computeVisibilityCanvasKit } from "./visibilityCanvasKit";
import { accumulatePolygon, getAccumulatedPolygon, getTotalVertexCount, resetAccumulator } from "./polygonAccumulator";
import { writePersistenceFogItem, removePersistenceFogItem } from "./fogWriter";
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

  const role = await OBR.player.getRole();
  console.log(`[Persistence] Player role: ${role}`);
  if (role !== "GM") return;

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
  });

  // Subscribe to scene item changes.
  // We cache FOG-layer items separately for the CanvasKit visibility pass
  // and also detect light-bearing token movement.
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
    settings = getMetadata<PersistenceSettings>(
      metadata,
      getPluginId("persistence-settings"),
      DEFAULT_PERSISTENCE_SETTINGS
    );

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

/** Reset all accumulated persistence data */
export async function resetPersistence(): Promise<void> {
  resetAccumulator();
  trackedTokens.clear();
  await removePersistenceFogItem();
}

/**
 * Handle scene item changes.
 * Identify light-bearing tokens and track their movement.
 */
async function handleItemsChange(items: Item[]): Promise<void> {
  if (!settings.enabled) return;

  // Find tokens with light metadata
  const lightTokens = items.filter(
    (item) => getPluginId("light") in item.metadata
  );

  // Update tracked tokens
  const currentIds = new Set<string>();
  for (const token of lightTokens) {
    currentIds.add(token.id);

    // Skip excluded tokens
    if (settings.excludedTokens.includes(token.id)) continue;

    const config = getMetadata<LightConfig>(
      token.metadata,
      getPluginId("light"),
      {}
    );

    const attenuationRadius = config.attenuationRadius ?? cachedDpi * 6;
    const outerAngle = config.outerAngle ?? 360;
    const innerAngle = config.innerAngle ?? outerAngle;
    const lightRotation = token.rotation + (config.rotation ?? 0);

    const tracked = trackedTokens.get(token.id);
    if (!tracked) {
      // New token: initialize tracking and compute first visibility
      const newTracked: TrackedToken = {
        itemId: token.id,
        lastComputedPosition: { ...token.position },
        attenuationRadius,
        outerAngle,
        innerAngle,
        lightRotation,
      };
      trackedTokens.set(token.id, newTracked);
      await computeAndAccumulate(token.position, newTracked);
    } else {
      // Existing token: check if it moved beyond the distance threshold
      const threshold = cachedDpi / 2;
      const dist = Math2.distance(token.position, tracked.lastComputedPosition);

      if (dist >= threshold) {
        tracked.lastComputedPosition = { ...token.position };
        tracked.attenuationRadius = attenuationRadius;
        tracked.outerAngle = outerAngle;
        tracked.innerAngle = innerAngle;
        tracked.lightRotation = lightRotation;
        await computeAndAccumulate(token.position, tracked);
      }
    }
  }

  // Remove tracked tokens that no longer have light metadata
  for (const id of trackedTokens.keys()) {
    if (!currentIds.has(id)) {
      trackedTokens.delete(id);
    }
  }
}

/**
 * Compute visibility at a position and accumulate it into the persistence polygon.
 * Uses CanvasKit path-boolean operations against FOG shapes for robust wall clipping.
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

  // Compute visibility by subtracting FOG shapes from the light circle
  const visRings = computeVisibilityCanvasKit(
    canvasKit,
    position,
    tracked.attenuationRadius,
    cachedFogItems,
    tracked.outerAngle,
    tracked.lightRotation
  );

  const t1 = performance.now();

  // Draw debug shapes if enabled (on every computation so they track the token)
  if (debugVis && canvasKit) {
    drawDebugShapes(
      canvasKit,
      position,
      tracked.attenuationRadius,
      cachedFogItems,
      tracked.outerAngle,
      tracked.lightRotation
    );
  }

  const totalVerts = visRings.reduce((sum, r) => sum + r.length, 0);
  console.log(
    `[Persistence] CanvasKit visibility: ${visRings.length} rings, ${totalVerts} total vertices ` +
    `(${cachedFogItems.length} FOG items, ${(t1 - t0).toFixed(1)}ms)`
  );

  if (visRings.length === 0) return;

  // Accumulate each ring into the running polygon
  let lastAccResult: ReturnType<typeof accumulatePolygon> = { status: "ok" };
  for (const ring of visRings) {
    if (ring.length < 3) continue;
    lastAccResult = accumulatePolygon(ring);
    if (lastAccResult.status === "rejected") break;
  }

  const t2 = performance.now();

  // If rejected, don't write — just publish the warning
  if (lastAccResult.status === "rejected") {
    await OBR.scene.setMetadata({
      [getPluginId("persistence-vertex-count")]: lastAccResult.vertexCount,
      [getPluginId("persistence-perf")]: {
        totalMs: 0,
        visMs: 0,
        unionMs: 0,
        wallCount: cachedFogItems.length,
        vertexCount: lastAccResult.vertexCount,
        status: "rejected",
      },
    });
    return;
  }

  // Write to the FOG layer
  const accumulated = getAccumulatedPolygon();
  if (accumulated) {
    await writePersistenceFogItem(accumulated);
  }

  const totalMs = performance.now() - t0;
  const visMs = t1 - t0;
  const unionMs = t2 - t1;
  const vertexCount = getTotalVertexCount();

  // Publish metrics to scene metadata for the action UI
  await OBR.scene.setMetadata({
    [getPluginId("persistence-vertex-count")]: vertexCount,
    [getPluginId("persistence-perf")]: {
      totalMs: Math.round(totalMs * 100) / 100,
      visMs: Math.round(visMs * 100) / 100,
      unionMs: Math.round(unionMs * 100) / 100,
      wallCount: cachedFogItems.length,
      vertexCount,
      status: lastAccResult.status,
    },
  });
}
