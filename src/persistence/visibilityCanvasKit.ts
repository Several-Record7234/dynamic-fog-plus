import type { CanvasKit, Path as SkPath } from "canvaskit-wasm";
import type { Vector2, Item } from "@owlbear-rodeo/sdk";
import { MathM } from "@owlbear-rodeo/sdk";
import { PathHelpers } from "../background/util/PathHelpers";
import { isDrawing } from "../types/Drawing";
import type { Drawing } from "../types/Drawing";
import type { Ring } from "./types";
import { PERSISTENCE_METADATA_KEY } from "./fogWriter";

/**
 * How far beyond the light radius to project shadow vertices.
 * 3× ensures the shadow frustum extends well past the boundary circle.
 */
const SHADOW_PROJECTION_FACTOR = 3;

/**
 * Compute visibility using CanvasKit path boolean operations.
 *
 * For each FOG-layer shape we:
 *  1. Subtract the filled shape itself (accurate curved boundary)
 *  2. Build a "shadow frustum" — a projection of the shape's outline
 *     away from the light source — and subtract that too
 *
 * Each subtraction is a separate PathOp.Difference call to avoid
 * winding-direction conflicts that occur when mixing sub-paths in
 * a single blocker path (opposing windings cancel under non-zero fill).
 */
export function computeVisibilityCanvasKit(
  CK: CanvasKit,
  origin: Vector2,
  radius: number,
  fogItems: Item[],
  outerAngle: number = 360,
  rotationDeg: number = 0
): Ring[] {
  // Build the light shape (full circle or cone sector)
  const lightPath = new CK.Path();

  if (outerAngle >= 360) {
    lightPath.addCircle(origin.x, origin.y, radius);
  } else {
    addSectorToPath(lightPath, origin, radius, outerAngle, rotationDeg);
  }

  let shapeCount = 0;
  const farDist = radius * SHADOW_PROJECTION_FACTOR;

  for (const item of fogItems) {
    if (item.layer !== "FOG") continue;
    if (!isDrawing(item)) continue;
    if (PERSISTENCE_METADATA_KEY in item.metadata) continue;

    const fogPath = PathHelpers.drawingToSkPath(item as Drawing, CK);
    if (!fogPath) continue;

    // Transform local-space path to world space
    const transform = MathM.fromItem(item);
    fogPath.transform(...transform);

    // 1. Subtract the filled fog shape (accurate curved boundary)
    lightPath.op(fogPath, CK.PathOp.Difference);

    // 2. Build and subtract the shadow frustum (area behind the shape)
    const frustumPath = buildShadowFrustum(CK, fogPath, origin, farDist);
    if (frustumPath) {
      lightPath.op(frustumPath, CK.PathOp.Difference);
      frustumPath.delete();
    }

    fogPath.delete();
    shapeCount++;
  }

  console.log(
    `[Persistence] CanvasKit visibility: ${shapeCount} fog shapes + shadow frustums subtracted`
  );

  // Convert the remaining path to polyline rings
  const commands = PathHelpers.skPathToPathCommands(lightPath);
  const polylines = PathHelpers.commandsToPolylines(CK, commands, 10);
  lightPath.delete();

  // Drop degenerate contours
  return polylines.filter((p) => p.length >= 3);
}

/**
 * Build a shadow frustum path for a fog shape.
 *
 * For each contour of the shape, creates a frustum polygon by tracing
 * the contour vertices forward, then their projections (from the light
 * source) backward:
 *
 *   V0 → V1 → … → VN → VN' → … → V1' → V0'
 *
 * where Vi' = origin + (Vi − origin) × (farDist / |Vi − origin|)
 *
 * Returns a NEW path (caller must delete) or null if no valid contours.
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

    // Project each vertex away from the light source
    const projected = verts.map((v) => {
      const dx = v.x - origin.x;
      const dy = v.y - origin.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.01) {
        // Degenerate: vertex at the light origin — push arbitrarily
        return { x: origin.x + farDist, y: origin.y };
      }
      const scale = farDist / len;
      return { x: origin.x + dx * scale, y: origin.y + dy * scale };
    });

    // Build a single frustum polygon: near vertices forward, far vertices
    // backward.  This gives one non-self-intersecting polygon for convex
    // shapes.  Per-edge quads were tried but adjacent quads wind in
    // opposite directions (toward-light vs away-from-light edges) causing
    // winding cancellation under non-zero fill.
    const flat: number[] = [];
    for (const v of verts) {
      flat.push(v.x, v.y);
    }
    for (let i = projected.length - 1; i >= 0; i--) {
      flat.push(projected[i].x, projected[i].y);
    }
    frustumPath.addPoly(flat, true);

    hasContent = true;
  }

  if (!hasContent) {
    frustumPath.delete();
    return null;
  }

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
