import type { CanvasKit, Path as SkPath } from "canvaskit-wasm";
import type { Vector2, Item } from "@owlbear-rodeo/sdk";
import { MathM } from "@owlbear-rodeo/sdk";
import { PathHelpers } from "../background/util/PathHelpers";
import { isDrawing } from "../types/Drawing";
import type { Drawing } from "../types/Drawing";
import { PERSISTENCE_METADATA_KEY } from "./fogWriter";
import type { VisibilityWorkerPool, PreparedFogShape } from "./workerPool";

/**
 * How far beyond the light radius to project shadow vertices.
 * 3× ensures the shadow frustum extends well past the boundary circle.
 */
export const SHADOW_PROJECTION_FACTOR = 3;

/**
 * Compute visibility using CanvasKit path boolean operations.
 *
 * Returns a CanvasKit Path representing the visible area.  The caller
 * owns the returned path and must call .delete() when done.
 *
 * For each FOG-layer shape we:
 *  1. Subtract the filled shape itself (accurate curved boundary)
 *  2. Build per-edge shadow quads projected away from the light,
 *     simplify them to resolve overlaps, and subtract the result
 */
export function computeVisibilityPath(
  CK: CanvasKit,
  origin: Vector2,
  radius: number,
  fogItems: Item[],
  outerAngle: number = 360,
  rotationDeg: number = 0
): SkPath {
  let lightPath = new CK.Path();

  if (outerAngle >= 360) {
    lightPath.addCircle(origin.x, origin.y, radius);
  } else {
    addSectorToPath(lightPath, origin, radius, outerAngle, rotationDeg);
  }

  let shapeCount = 0;
  let shapeOpFails = 0;
  let frustumOpFails = 0;
  const farDist = radius * SHADOW_PROJECTION_FACTOR;

  for (const item of fogItems) {
    if (item.layer !== "FOG") continue;
    if (!isDrawing(item)) continue;
    if (PERSISTENCE_METADATA_KEY in item.metadata) continue;

    const drawing = item as Drawing;
    const fogPath = PathHelpers.drawingToSkPath(drawing, CK);
    if (!fogPath) continue;

    // Normalize fill type to EvenOdd so winding direction doesn't affect
    // which area is considered "filled". Without this, a shape drawn in
    // reverse winding can cause PathOp.Difference to subtract the exterior
    // (entire map) instead of the shape interior.
    fogPath.setFillType(CK.FillType.EvenOdd);

    // Transform fogPath in place — no copy needed since drawingToSkPath
    // creates a fresh path each iteration and we discard it after use.
    fogPath.transform(...MathM.fromItem(item));

    {
      const backup = lightPath.copy();
      if (!lightPath.op(fogPath, CK.PathOp.Difference)) {
        shapeOpFails++;
        console.warn(`[Persistence] PathOp.Difference FAILED for shape "${item.name || item.id.slice(0, 8)}", skipping`);
        lightPath.delete();
        lightPath = backup;
      } else {
        backup.delete();
      }
    }

    const frustumPath = buildShadowFrustum(CK, fogPath, origin, farDist);
    if (frustumPath) {
      const backup = lightPath.copy();
      if (!lightPath.op(frustumPath, CK.PathOp.Difference)) {
        frustumOpFails++;
        console.warn(`[Persistence] PathOp.Difference FAILED for frustum of "${item.name || item.id.slice(0, 8)}", skipping`);
        lightPath.delete();
        lightPath = backup;
      } else {
        backup.delete();
      }
      frustumPath.delete();
    }

    fogPath.delete();
    shapeCount++;
  }

  if (shapeOpFails > 0 || frustumOpFails > 0) {
    console.warn(
      `[Persistence] CanvasKit visibility: ${shapeOpFails} shape + ${frustumOpFails} frustum op failures`
    );
  }
  return lightPath;
}


/**
 * Build a shadow frustum path for a fog shape using per-edge quads.
 *
 * For each edge (Vi, Vi+1) of each contour, builds a quadrilateral:
 *   Vi → Vi+1 → Vi+1' → Vi'
 * where Vi' = origin + (Vi − origin) × (farDist / |Vi − origin|)
 *
 * Individual quads are always simple (non-self-intersecting). However,
 * edges on opposite sides of the shape produce quads with opposite winding
 * directions.  Under the default Winding fill rule, overlapping quads with
 * opposite winding cancel to winding-number 0 (unfilled), leaving a hollow
 * shadow cone.  We enforce consistent winding so that overlapping areas
 * always have non-zero winding, then call path.simplify() to merge them.
 *
 * Returns the simplified frustum path, or null if no valid contours.
 */
function buildShadowFrustum(
  CK: CanvasKit,
  shapePath: SkPath,
  origin: Vector2,
  farDist: number
): SkPath | null {
  const commands = PathHelpers.skPathToPathCommands(shapePath);
  const contours = PathHelpers.commandsToPolylines(CK, commands, 15);

  let hasContent = false;
  const frustumPath = new CK.Path();

  for (let verts of contours) {
    if (verts.length < 3) continue;

    // Strip duplicate closing vertex (commandsToPolylines adds start point
    // at the end when it encounters a CLOSE command)
    const first = verts[0];
    const last = verts[verts.length - 1];
    if ((last.x - first.x) ** 2 + (last.y - first.y) ** 2 < 1) {
      verts = verts.slice(0, -1);
    }
    if (verts.length < 3) continue;

    // Build one quad per edge with consistent winding direction.
    // Vertex projection is computed inline to avoid allocating an
    // intermediate array of projected Vector2 objects.
    for (let i = 0; i < verts.length; i++) {
      const j = (i + 1) % verts.length;
      const ax = verts[i].x, ay = verts[i].y;
      const bx = verts[j].x, by = verts[j].y;

      // Project a (vertex i) away from origin
      const dax = ax - origin.x, day = ay - origin.y;
      const lenA = Math.sqrt(dax * dax + day * day);
      const sA = lenA < 0.01 ? farDist : farDist / lenA;
      const dx = origin.x + dax * sA, dy = origin.y + day * sA;

      // Project b (vertex j) away from origin
      const dbx = bx - origin.x, dby = by - origin.y;
      const lenB = Math.sqrt(dbx * dbx + dby * dby);
      const sB = lenB < 0.01 ? farDist : farDist / lenB;
      const cx = origin.x + dbx * sB, cy = origin.y + dby * sB;

      // Signed area of quad (ax,ay)→(bx,by)→(cx,cy)→(dx,dy)
      // Positive = CW in screen coords (y-down)
      const sa = (ax * by - bx * ay) + (bx * cy - cx * by)
               + (cx * dy - dx * cy) + (dx * ay - ax * dy);

      if (sa >= 0) {
        frustumPath.moveTo(ax, ay);
        frustumPath.lineTo(bx, by);
        frustumPath.lineTo(cx, cy);
        frustumPath.lineTo(dx, dy);
      } else {
        frustumPath.moveTo(ax, ay);
        frustumPath.lineTo(dx, dy);
        frustumPath.lineTo(cx, cy);
        frustumPath.lineTo(bx, by);
      }
      frustumPath.close();
    }

    hasContent = true;
  }

  if (!hasContent) {
    frustumPath.delete();
    return null;
  }

  // Resolve overlapping quads into a single clean outline
  frustumPath.simplify();

  return frustumPath;
}

/**
 * Add a pie-slice sector to a CanvasKit path.
 *
 * OBR rotation convention: 0 = up/north, clockwise positive.
 * We convert to standard math angles (0 = right/east, CCW positive).
 */
function addSectorToPath(
  path: SkPath,
  origin: Vector2,
  radius: number,
  outerAngleDeg: number,
  rotationDeg: number
): void {
  // OBR 0° = up → math -90°; OBR CW → math CCW after sign flip
  const centerAngle = ((rotationDeg - 90) * Math.PI) / 180;
  const halfAngle = ((outerAngleDeg / 2) * Math.PI) / 180;
  const startAngle = centerAngle - halfAngle;
  const endAngle = centerAngle + halfAngle;

  path.moveTo(origin.x, origin.y);

  const arcSteps = Math.max(16, Math.ceil(outerAngleDeg / 5));
  const angleStep = (endAngle - startAngle) / arcSteps;

  for (let i = 0; i <= arcSteps; i++) {
    const a = startAngle + i * angleStep;
    path.lineTo(
      origin.x + Math.cos(a) * radius,
      origin.y + Math.sin(a) * radius
    );
  }

  path.close();
}

/**
 * Parallel visibility computation using Web Workers.
 *
 * Workers compute the union of (fog shape + shadow frustum) for batches
 * of pre-processed shapes.  The main thread creates the light circle and
 * subtracts each worker's combined result.
 *
 * Mathematically equivalent to the sequential version:
 *   lightCircle - A₁ - A₂ - ... = lightCircle - (A₁ ∪ A₂ ∪ ...)
 */
export async function computeVisibilityPathParallel(
  CK: CanvasKit,
  origin: Vector2,
  radius: number,
  preparedShapes: PreparedFogShape[],
  pool: VisibilityWorkerPool,
  outerAngle: number = 360,
  rotationDeg: number = 0
): Promise<SkPath> {
  let lightPath = new CK.Path();

  if (outerAngle >= 360) {
    lightPath.addCircle(origin.x, origin.y, radius);
  } else {
    addSectorToPath(lightPath, origin, radius, outerAngle, rotationDeg);
  }

  const farDist = radius * SHADOW_PROJECTION_FACTOR;

  // Distribute shapes to workers and collect results
  const batchResults = await pool.computeBatches(preparedShapes, origin, farDist);

  // Subtract each worker's combined result from the light circle
  for (const cmds of batchResults) {
    if (cmds.length === 0) continue;
    const subPath = CK.Path.MakeFromCmds(cmds);
    if (!subPath) continue;
    const backup = lightPath.copy();
    if (!lightPath.op(subPath, CK.PathOp.Difference)) {
      console.warn("[Persistence] PathOp.Difference FAILED for worker batch, skipping");
      lightPath.delete();
      lightPath = backup;
    } else {
      backup.delete();
    }
    subPath.delete();
  }

  return lightPath;
}
