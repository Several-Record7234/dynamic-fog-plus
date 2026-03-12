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
  // Count ALL commands (including CLOSE) — OBR's ~500 limit applies to
  // the total command array length, not just vertices.
  cachedVertexCount = cachedCommands.length;
  cacheValid = true;
}

/**
 * Vertex budget thresholds.
 *
 * OBR silently rejects Path item updates when the total command count
 * exceeds ~500.  Each ring adds a CLOSE command, so total commands =
 * vertices + number_of_rings.  We target vertex counts that keep the
 * total command count safely below 500.
 *
 * - SIMPLIFY_SOFT:  periodic low-tolerance simplification (imperceptible)
 * - SIMPLIFY_HARD:  aggressive simplification at higher tolerance
 * - REJECT:         refuse to accumulate (the UI warns to reset)
 */
const SIMPLIFY_SOFT_CMD_COUNT = 200;
const SIMPLIFY_HARD_CMD_COUNT = 350;
const REJECT_CMD_COUNT = 450;

/** Simplify every N unions even if under threshold (keeps things tidy) */
const SIMPLIFY_INTERVAL = 5;

/** Douglas-Peucker tolerances in scene pixels */
const TOLERANCE_SOFT = 2;
const TOLERANCE_HARD = 5;


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
  const currentCount = getTotalCommandCount();

  if (currentCount >= REJECT_CMD_COUNT) {
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
  const newCount = getTotalCommandCount();

  if (newCount >= SIMPLIFY_HARD_CMD_COUNT) {
    simplifyAccumulated(TOLERANCE_HARD);
    unionsSinceSimplify = 0;
    return { status: "simplified", tolerance: TOLERANCE_HARD };
  }

  if (unionsSinceSimplify >= SIMPLIFY_INTERVAL || newCount > SIMPLIFY_SOFT_CMD_COUNT) {
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

/** Get the total command count of the accumulated path (cached, no serialisation).
 *  Includes all verbs (MOVE, LINE, QUAD, CUBIC, CONIC, CLOSE) since OBR's
 *  ~500 limit applies to the total command array length. */
export function getTotalCommandCount(): number {
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
 * Apply Douglas-Peucker simplification to the accumulated path,
 * preserving native curve commands (QUAD, CUBIC, CONIC).
 *
 * Only consecutive runs of LINE commands are simplified.  Curve commands
 * pass through unchanged — they encode far more visual information per
 * command than line segments (e.g. a single CONIC can represent an entire
 * circular arc that would otherwise cost 20–40 LINE commands).
 *
 * This dramatically reduces command count for the same visual fidelity,
 * extending how much area can be explored before hitting OBR's ~500
 * command ceiling.
 */
function simplifyAccumulated(tolerance: number): void {
  if (!accumulated || !ck) return;

  const commands = PathHelpers.skPathToPathCommands(accumulated);
  const newPath = new ck.Path();

  // Track current position so we know the start of each LINE run
  let curX = 0, curY = 0;

  // Accumulate consecutive LINE endpoints for batch simplification.
  // lineRun[0] is always the starting point (current position before
  // the first LINE in the run); lineRun[1..n] are LINE endpoints.
  let lineRun: { x: number; y: number }[] = [];

  function flushLineRun() {
    if (lineRun.length <= 1) {
      lineRun = [];
      return;
    }
    if (lineRun.length === 2) {
      // Single line segment — emit directly, nothing to simplify
      newPath.lineTo(lineRun[1].x, lineRun[1].y);
      lineRun = [];
      return;
    }
    // Simplify the run (includes start point); skip first point
    // (already the current path position) and emit the rest
    const simplified = simplify(lineRun, tolerance, true);
    for (let i = 1; i < simplified.length; i++) {
      newPath.lineTo(simplified[i].x, simplified[i].y);
    }
    lineRun = [];
  }

  for (const cmd of commands) {
    switch (cmd[0]) {
      case Command.MOVE:
        flushLineRun();
        newPath.moveTo(cmd[1], cmd[2]);
        curX = cmd[1]; curY = cmd[2];
        break;

      case Command.LINE:
        if (lineRun.length === 0) {
          lineRun.push({ x: curX, y: curY });
        }
        lineRun.push({ x: cmd[1], y: cmd[2] });
        curX = cmd[1]; curY = cmd[2];
        break;

      case Command.QUAD:
        flushLineRun();
        newPath.quadTo(cmd[1], cmd[2], cmd[3], cmd[4]);
        curX = cmd[3]; curY = cmd[4];
        break;

      case Command.CONIC:
        flushLineRun();
        newPath.conicTo(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5]);
        curX = cmd[3]; curY = cmd[4];
        break;

      case Command.CUBIC:
        flushLineRun();
        newPath.cubicTo(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
        curX = cmd[5]; curY = cmd[6];
        break;

      case Command.CLOSE:
        flushLineRun();
        newPath.close();
        break;
    }
  }
  flushLineRun();

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
