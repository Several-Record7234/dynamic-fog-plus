import OBR, { buildPath, Command, isPath } from "@owlbear-rodeo/sdk";
import type { PathCommand } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import type { Ring } from "./types";

/** The metadata key that marks a fog item as a persistence cutout */
export const PERSISTENCE_METADATA_KEY = getPluginId("persistence");

/** Cached ID of the persistence fog item (so we can update rather than recreate) */
let persistenceItemId: string | null = null;

/**
 * Write or update the persistence fog cutout on the FOG layer.
 *
 * @param multiPolygon - Array of polygon ring arrays. Each polygon has
 *   an outer ring at index 0 and optional hole rings at index 1+.
 *   Each ring is an array of {x, y} vertices.
 */
export async function writePersistenceFogItem(
  multiPolygon: Ring[][]
): Promise<void> {
  const commands = multiPolygonToPathCommands(multiPolygon);
  if (commands.length === 0) return;

  if (persistenceItemId) {
    // Update existing item
    try {
      await OBR.scene.items.updateItems([persistenceItemId], (items) => {
        for (const item of items) {
          if (isPath(item)) {
            item.commands = commands;
          }
        }
      });
      return;
    } catch {
      // Item may have been deleted externally; fall through to create
      persistenceItemId = null;
    }
  }

  // Check if a persistence item already exists (e.g. from a previous session)
  const existingItems = await OBR.scene.items.getItems((item) => {
    return (
      item.layer === "FOG" &&
      isPath(item) &&
      PERSISTENCE_METADATA_KEY in item.metadata
    );
  });

  if (existingItems.length > 0) {
    // Reuse existing item
    persistenceItemId = existingItems[0].id;
    await OBR.scene.items.updateItems([persistenceItemId], (items) => {
      for (const item of items) {
        if (isPath(item)) {
          item.commands = commands;
        }
      }
    });
    return;
  }

  // Create new persistence fog item
  const path = buildPath()
    .commands(commands)
    .fillRule("evenodd")
    .layer("FOG")
    .visible(false) // visible: false = fog cutout (reveals map)
    .locked(true)
    .disableHit(true)
    .name("Persistence Fog")
    .metadata({ [PERSISTENCE_METADATA_KEY]: true })
    .fillColor("#000000")
    .fillOpacity(1)
    .strokeWidth(0)
    .strokeOpacity(0)
    .strokeColor("#000000")
    .build();

  await OBR.scene.items.addItems([path]);
  persistenceItemId = path.id;
}

/** Remove the persistence fog item from the scene */
export async function removePersistenceFogItem(): Promise<void> {
  if (persistenceItemId) {
    try {
      await OBR.scene.items.deleteItems([persistenceItemId]);
    } catch {
      // Item may already be gone
    }
    persistenceItemId = null;
    return;
  }

  // Also check for orphaned persistence items
  const existingItems = await OBR.scene.items.getItems((item) => {
    return (
      item.layer === "FOG" &&
      isPath(item) &&
      PERSISTENCE_METADATA_KEY in item.metadata
    );
  });

  if (existingItems.length > 0) {
    await OBR.scene.items.deleteItems(existingItems.map((i) => i.id));
  }
}

/**
 * Read existing persistence geometry from the scene (for restoring state on load).
 * Returns rings extracted from the Path item's commands, or null if none exists.
 */
export async function readPersistenceFogItem(): Promise<Ring[][] | null> {
  const existingItems = await OBR.scene.items.getItems((item) => {
    return (
      item.layer === "FOG" &&
      isPath(item) &&
      PERSISTENCE_METADATA_KEY in item.metadata
    );
  });

  if (existingItems.length === 0) return null;

  const item = existingItems[0];
  persistenceItemId = item.id;

  if (!isPath(item)) return null;

  return pathCommandsToRings(item.commands);
}

/**
 * Convert a multi-polygon (array of polygon ring arrays) to OBR PathCommands.
 * Each ring becomes an M, L..., Z subpath.
 */
function multiPolygonToPathCommands(multiPolygon: Ring[][]): PathCommand[] {
  const commands: PathCommand[] = [];

  for (const polygon of multiPolygon) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;

      // Move to first point
      commands.push([Command.MOVE, ring[0].x, ring[0].y]);

      // Line to subsequent points
      for (let i = 1; i < ring.length; i++) {
        commands.push([Command.LINE, ring[i].x, ring[i].y]);
      }

      // Close the subpath
      commands.push([Command.CLOSE]);
    }
  }

  return commands;
}

/**
 * Extract rings from PathCommands (reverse of multiPolygonToPathCommands).
 * Used to restore accumulated state from an existing persistence fog item.
 */
function pathCommandsToRings(commands: PathCommand[]): Ring[][] {
  const polygons: Ring[][] = [];
  let currentRings: Ring[] = [];
  let currentRing: Ring = [];

  for (const cmd of commands) {
    switch (cmd[0]) {
      case Command.MOVE:
        // Start a new ring
        if (currentRing.length > 0) {
          currentRings.push(currentRing);
        }
        currentRing = [{ x: cmd[1], y: cmd[2] }];
        break;
      case Command.LINE:
        currentRing.push({ x: cmd[1], y: cmd[2] });
        break;
      case Command.CLOSE:
        if (currentRing.length >= 3) {
          currentRings.push(currentRing);
        }
        currentRing = [];
        break;
    }
  }

  // Handle final ring if not closed
  if (currentRing.length >= 3) {
    currentRings.push(currentRing);
  }

  // Group rings into polygons: each MOVE after a CLOSE starts a potential new polygon
  // For simplicity, treat each outer+holes group as one polygon
  // The first ring in a group is the outer ring, subsequent rings are holes
  if (currentRings.length > 0) {
    polygons.push(currentRings);
  }

  return polygons;
}
