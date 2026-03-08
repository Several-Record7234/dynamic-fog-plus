import OBR, {
  Item,
  isWall,
  Wall,
  Vector2,
  Math2,
} from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { getMetadata } from "../util/getMetadata";
import type { LightConfig } from "../types/LightConfig";
import type { TrackedToken, WallSegment, PersistenceSettings } from "./types";
import { DEFAULT_PERSISTENCE_SETTINGS } from "./types";
import { computeVisibilityPolygon } from "./visibilityPolygon";
import { accumulatePolygon, getAccumulatedPolygon, getTotalVertexCount, resetAccumulator } from "./polygonAccumulator";
import { writePersistenceFogItem, removePersistenceFogItem } from "./fogWriter";

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

/**
 * Cached wall items from the local scene.
 * Populated via OBR.scene.local.onChange so we always have the latest walls
 * without racing the Reconciler's batched Patcher writes.
 */
let cachedWalls: Wall[] = [];

/**
 * Initialize the position tracker.
 * Only runs on the GM's client to avoid write conflicts — every connected
 * client runs the background page, but only one should own the persistence
 * fog item and accumulated polygon state.
 */
export async function initPositionTracker(): Promise<void> {
  const role = await OBR.player.getRole();
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

  // Subscribe to local scene changes to cache wall items.
  // The Reconciler creates local Wall items asynchronously via a batched Patcher,
  // so querying OBR.scene.local.getItems(isWall) at compute time would race the
  // Patcher's submitChanges(). Instead we keep a live cache updated by onChange.
  const unsubLocal = OBR.scene.local.onChange((items) => {
    cachedWalls = items.filter(isWall);
    console.debug(
      `[Persistence] Local walls updated: ${cachedWalls.length} walls`
    );
  });

  // Seed the wall cache with whatever exists right now
  OBR.scene.local.getItems(isWall).then((walls) => {
    cachedWalls = walls;
    console.debug(
      `[Persistence] Initial wall cache: ${cachedWalls.length} walls`
    );
  });

  // Subscribe to scene item changes
  const unsubItems = OBR.scene.items.onChange(handleItemsChange);

  // Subscribe to scene metadata changes (settings updates and reset signals from action UI)
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
  });

  // Subscribe to scene ready changes (clear on scene switch)
  const unsubReady = OBR.scene.onReadyChange((ready) => {
    if (!ready) {
      trackedTokens.clear();
      cachedWalls = [];
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

  unsubscribes = [unsubLocal, unsubItems, unsubMeta, unsubReady];
}

/** Clean up subscriptions */
export function destroyPositionTracker(): void {
  for (const unsub of unsubscribes) {
    unsub();
  }
  unsubscribes = [];
  trackedTokens.clear();
  cachedWalls = [];
}

/** Update persistence settings (called from GM controls) */
export function updatePersistenceSettings(
  newSettings: Partial<PersistenceSettings>
): void {
  settings = { ...settings, ...newSettings };
  // Persist to scene metadata
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
 * Instruments each phase with performance.now() and publishes timing data.
 */
async function computeAndAccumulate(
  position: Vector2,
  tracked: TrackedToken
): Promise<void> {
  const t0 = performance.now();

  // Use cached wall geometry (kept in sync by OBR.scene.local.onChange)
  const wallSegments = wallItemsToSegments(cachedWalls);

  console.debug(
    `[Persistence] Computing visibility: ${cachedWalls.length} wall items -> ${wallSegments.length} segments`
  );

  const t1 = performance.now();

  // Compute visibility polygon
  const visPolygon = computeVisibilityPolygon(
    position,
    tracked.attenuationRadius,
    wallSegments,
    tracked.outerAngle,
    tracked.lightRotation
  );

  const t2 = performance.now();

  if (visPolygon.length < 3) return;

  // Accumulate into the running polygon
  const accResult = accumulatePolygon(visPolygon);

  const t3 = performance.now();

  // If rejected, don't write — just publish the warning
  if (accResult.status === "rejected") {
    await OBR.scene.setMetadata({
      [getPluginId("persistence-vertex-count")]: accResult.vertexCount,
      [getPluginId("persistence-perf")]: {
        totalMs: 0,
        visMs: 0,
        unionMs: 0,
        wallCount: wallSegments.length,
        vertexCount: accResult.vertexCount,
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
  const visMs = t2 - t1;
  const unionMs = t3 - t2;
  const wallCount = wallSegments.length;
  const vertexCount = getTotalVertexCount();

  // Publish metrics to scene metadata for the action UI
  await OBR.scene.setMetadata({
    [getPluginId("persistence-vertex-count")]: vertexCount,
    [getPluginId("persistence-perf")]: {
      totalMs: Math.round(totalMs * 100) / 100,
      visMs: Math.round(visMs * 100) / 100,
      unionMs: Math.round(unionMs * 100) / 100,
      wallCount,
      vertexCount,
      status: accResult.status,
    },
  });
}

/**
 * Convert Wall items from the local scene into flat WallSegment arrays.
 * Walls are polylines: each consecutive pair of points is a segment.
 * Wall positions, rotations, and scales must be applied to get world-space coordinates.
 */
function wallItemsToSegments(walls: Wall[]): WallSegment[] {
  const segments: WallSegment[] = [];

  for (const wall of walls) {
    const points = wall.points;
    if (points.length < 2) continue;

    // Transform points to world space using wall's position, rotation, scale
    const worldPoints = transformPoints(
      points,
      wall.position,
      wall.rotation,
      wall.scale
    );

    // Convert consecutive point pairs to segments
    for (let i = 0; i < worldPoints.length - 1; i++) {
      segments.push({
        a: worldPoints[i],
        b: worldPoints[i + 1],
      });
    }

    // Close the polyline (walls are closed loops around fog shapes)
    if (worldPoints.length > 2) {
      segments.push({
        a: worldPoints[worldPoints.length - 1],
        b: worldPoints[0],
      });
    }
  }

  return segments;
}

/**
 * Transform an array of local-space points to world space
 * using position offset, rotation, and scale.
 */
function transformPoints(
  points: Vector2[],
  position: Vector2,
  rotationDeg: number,
  scale: Vector2
): Vector2[] {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return points.map((p) => {
    // Apply scale
    const sx = p.x * scale.x;
    const sy = p.y * scale.y;
    // Apply rotation
    const rx = sx * cos - sy * sin;
    const ry = sx * sin + sy * cos;
    // Apply translation
    return {
      x: rx + position.x,
      y: ry + position.y,
    };
  });
}
