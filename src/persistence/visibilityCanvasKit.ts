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
 * For each FOG-layer shape we build a "shadow frustum" — the shape itself
 * plus a projection of its silhouette away from the light source — and
 * collect everything into a single blocker path.  One PathOp.Difference
 * then removes the blocker from the light circle.
 *
 * This approach handles both:
 *  - Shape occlusion (the filled fog shape blocks the shape interior)
 *  - Line-of-sight shadows (the frustum blocks the area BEHIND each shape)
 *
 * It replaces the custom angular-sweep algorithm which leaked at
 * wall-corner junctions and struggled with numerical precision.
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

  // Accumulate all fog shapes + their shadow frustums into one blocker path
  const blockerPath = new CK.Path();
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

    // Add the filled fog shape itself (accurate curves)
    blockerPath.addPath(fogPath);

    // Add the shadow frustum (covers everything behind the shape)
    addShadowFrustum(CK, blockerPath, fogPath, origin, farDist);

    fogPath.delete();
    shapeCount++;
  }

  // Single boolean difference: light minus all blockers+shadows
  if (shapeCount > 0) {
    lightPath.op(blockerPath, CK.PathOp.Difference);
  }
  blockerPath.delete();

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
 * Add a shadow frustum to `out` for each contour of `shapePath`.
 *
 * The frustum is a single polygon formed by tracing the shape's vertices
 * forward, then tracing the projected vertices backward:
 *
 *   V0 → V1 → … → VN → VN' → … → V1' → V0'
 *
 * where Vi' = origin + (Vi − origin) × (farDist / |Vi − origin|)
 *
 * For a convex shape this creates a clean frustum.  For concave shapes the
 * polygon may self-intersect, but CanvasKit's winding fill rule handles
 * that correctly — the net effect is that everything behind the shape
 * (from the light's perspective) is covered.
 */
function addShadowFrustum(
  CK: CanvasKit,
  out: SkPath,
  shapePath: SkPath,
  origin: Vector2,
  farDist: number
): void {
  const commands = PathHelpers.skPathToPathCommands(shapePath);
  const contours = PathHelpers.commandsToPolylines(CK, commands, 15);

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
        // Degenerate: vertex at the light origin — push in an arbitrary direction
        return { x: origin.x + farDist, y: origin.y };
      }
      const scale = farDist / len;
      return { x: origin.x + dx * scale, y: origin.y + dy * scale };
    });

    // Build the frustum polygon: original vertices forward, projected backward
    const flat: number[] = [];
    for (const v of verts) {
      flat.push(v.x, v.y);
    }
    for (let i = projected.length - 1; i >= 0; i--) {
      flat.push(projected[i].x, projected[i].y);
    }

    out.addPoly(flat, true);
  }
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
