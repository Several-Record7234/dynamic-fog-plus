import OBR, { buildPath, isPath } from "@owlbear-rodeo/sdk";
import type { PathCommand } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";

/** The metadata key that marks a fog item as a persistence cutout */
export const PERSISTENCE_METADATA_KEY = getPluginId("persistence");

/** Cached ID of the persistence fog item (so we can update rather than recreate) */
let persistenceItemId: string | null = null;

/**
 * Write or update the persistence fog cutout on the FOG layer.
 *
 * @param commands - OBR PathCommands describing the revealed area.
 *   Comes directly from the CanvasKit-based accumulator.
 */
export async function writePersistenceFogItem(
  commands: PathCommand[]
): Promise<void> {
  if (commands.length === 0) return;

  if (persistenceItemId) {
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
 * Returns the raw PathCommands, or null if no persistence item exists.
 */
export async function readPersistenceFogItem(): Promise<PathCommand[] | null> {
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

  return item.commands;
}
