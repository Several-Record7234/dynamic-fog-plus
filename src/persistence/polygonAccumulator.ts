import type { CanvasKit, Path as SkPath } from "canvaskit-wasm";
import type { PathCommand } from "@owlbear-rodeo/sdk";
import { Command } from "@owlbear-rodeo/sdk";
import simplify from "simplify-js";
import { PathHelpers } from "../background/util/PathHelpers";

/**
 * CanvasKit-based polygon accumulator.
 *
 * Uses PathOp.Union to merge visibility paths, which correctly preserves
 * holes (fog shape carve-outs) that polygon-clipping's per-ring union lost.
 */

/** The accumulated CanvasKit Path (caller must init before use) */
let accumulated: SkPath | null = null;

/** Cached CanvasKit instance (set via initAccumulator) */
let ck: CanvasKit | null = null;

/** Count of union operations since last simplification */
let unionsSinceSimplify = 0;

/**
 * Serialisation cache — avoids repeated skPathToPathCommands() calls.
 * Invalidated whenever the accumulated path mutates (union, simplify, reset).
 */
let cachedCommands: PathCommand[] | null = null;
let cachedVertexCount = 0;
let cacheValid = false;

function invalidateCache(): void {
  cachedCommands = null;
  cacheValid = false;
}

function ensureCache(): void {
  if (cacheValid || !accumulated) return;
  cachedCommands = PathHelpers.skPathToPathCommands(accumulated);
  cachedVertexCount = 0;
  for (const cmd of cachedCommands) {
    if (cmd[0] !== Command.CLOSE) cachedVertexCount++;
  }
  cacheValid = true;
}

/**
 * Vertex budget thresholds.
 *
 * - SIMPLIFY_SOFT:  periodic low-tolerance simplification (imperceptible)
 * - SIMPLIFY_HARD:  aggressive simplification at higher tolerance
 * - REJECT:         refuse to accumulate (the UI warns to reset)
 */
const SIMPLIFY_SOFT_VERTEX_COUNT = 1500;
const SIMPLIFY_HARD_VERTEX_COUNT = 3000;
const REJECT_VERTEX_COUNT = 8000;

/** Simplify every N unions even if under threshold (keeps things tidy) */
const SIMPLIFY_INTERVAL = 10;

/** Douglas-Peucker tolerances in scene pixels */
const TOLERANCE_SOFT = 1.5;
const TOLERANCE_HARD = 4;


/** Result of an accumulate call, for the caller to react to */
export type AccumulateResult =
  | { status: "ok" }
  | { status: "simplified"; tolerance: number }
  | { status: "rejected"; vertexCount: number };

/** Store the CanvasKit reference for path operations */
export function initAccumulator(CK: CanvasKit): void {
  ck = CK;
}

/**
 * Union a visibility path into the accumulated area.
 *
 * Unlike the old per-ring approach, this operates on the full CanvasKit path
 * which correctly preserves holes (fog shape carve-outs) through the union.
 */
export function accumulateVisibilityPath(visPath: SkPath): AccumulateResult {
  if (!ck) throw new Error("Accumulator not initialized — call initAccumulator first");

  // Use cached count (no serialisation) for the reject check
  const currentCount = getTotalVertexCount();

  if (currentCount >= REJECT_VERTEX_COUNT) {
    return { status: "rejected", vertexCount: currentCount };
  }

  if (!accumulated) {
    accumulated = visPath.copy();
  } else {
    accumulated.op(visPath, ck.PathOp.Union);
  }

  // Path mutated — invalidate cache and recount once
  invalidateCache();
  unionsSinceSimplify++;
  const newCount = getTotalVertexCount();

  if (newCount >= SIMPLIFY_HARD_VERTEX_COUNT) {
    simplifyAccumulated(TOLERANCE_HARD);
    unionsSinceSimplify = 0;
    return { status: "simplified", tolerance: TOLERANCE_HARD };
  }

  if (unionsSinceSimplify >= SIMPLIFY_INTERVAL || newCount > SIMPLIFY_SOFT_VERTEX_COUNT) {
    simplifyAccumulated(TOLERANCE_SOFT);
    unionsSinceSimplify = 0;
    return { status: "simplified", tolerance: TOLERANCE_SOFT };
  }

  return { status: "ok" };
}

/**
 * Get the accumulated path as OBR PathCommands, ready for the fog writer.
 * Returns null if nothing has been accumulated.
 */
export function getAccumulatedPathCommands(): PathCommand[] | null {
  if (!accumulated) return null;
  ensureCache();
  return cachedCommands;
}

/** Get the total vertex count of the accumulated path (cached, no serialisation) */
export function getTotalVertexCount(): number {
  if (!accumulated) return 0;
  ensureCache();
  return cachedVertexCount;
}

/** Reset the accumulator (clear all persistence data) */
export function resetAccumulator(): void {
  if (accumulated) {
    accumulated.delete();
    accumulated = null;
  }
  unionsSinceSimplify = 0;
  invalidateCache();
}

/**
 * Restore accumulated state from a previously saved set of PathCommands.
 * Called on startup to restore from the existing fog item's geometry.
 */
export function restoreFromPathCommands(commands: PathCommand[]): void {
  if (!ck) throw new Error("Accumulator not initialized — call initAccumulator first");
  resetAccumulator();
  if (commands.length === 0) return;
  accumulated = pathCommandsToSkPath(ck, commands);
  invalidateCache();
}

/**
 * Apply Douglas-Peucker simplification to the accumulated path.
 *
 * Converts to polylines, simplifies each, and rebuilds the path.
 * Winding direction is preserved because simplify-js only removes
 * intermediate points without reordering.
 */
function simplifyAccumulated(tolerance: number): void {
  if (!accumulated || !ck) return;

  const commands = PathHelpers.skPathToPathCommands(accumulated);
  const polylines = PathHelpers.commandsToPolylines(ck, commands, 10);

  const newPath = new ck.Path();

  for (let verts of polylines) {
    if (verts.length < 3) continue;

    // Strip duplicate closing vertex
    const first = verts[0];
    const last = verts[verts.length - 1];
    if ((last.x - first.x) ** 2 + (last.y - first.y) ** 2 < 1) {
      verts = verts.slice(0, -1);
    }
    if (verts.length < 3) continue;

    const simplified = simplify(verts, tolerance, true);
    if (simplified.length < 3) continue;

    newPath.moveTo(simplified[0].x, simplified[0].y);
    for (let i = 1; i < simplified.length; i++) {
      newPath.lineTo(simplified[i].x, simplified[i].y);
    }
    newPath.close();
  }

  accumulated.delete();
  accumulated = newPath;
  invalidateCache();
}

/** Convert OBR PathCommands to a CanvasKit Path */
function pathCommandsToSkPath(CK: CanvasKit, commands: PathCommand[]): SkPath {
  const path = new CK.Path();
  for (const cmd of commands) {
    switch (cmd[0]) {
      case Command.MOVE:
        path.moveTo(cmd[1], cmd[2]);
        break;
      case Command.LINE:
        path.lineTo(cmd[1], cmd[2]);
        break;
      case Command.QUAD:
        path.quadTo(cmd[1], cmd[2], cmd[3], cmd[4]);
        break;
      case Command.CONIC:
        path.conicTo(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5]);
        break;
      case Command.CUBIC:
        path.cubicTo(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
        break;
      case Command.CLOSE:
        path.close();
        break;
    }
  }
  return path;
}
