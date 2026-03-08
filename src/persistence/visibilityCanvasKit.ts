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
  let shapeOpFails = 0;
  let frustumOpFails = 0;
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
    const shapeOk = lightPath.op(fogPath, CK.PathOp.Difference);
    if (!shapeOk) shapeOpFails++;

    // 2. Build and subtract the shadow frustum (area behind the shape)
    const frustumInfo = buildShadowFrustum(CK, fogPath, origin, farDist);
    if (frustumInfo) {
      // Diagnostic: log the first shape's frustum details
      if (shapeCount === 0) {
        console.log(
          `[Persistence] DIAG shape #0: item.name="${item.name}" ` +
          `type="${item.type}" visible=${item.visible}`
        );
        console.log(
          `[Persistence] DIAG shape #0: contours=${frustumInfo.contourCount} ` +
          `nearVerts=${frustumInfo.nearVertCount} ` +
          `frustumVertCount=${frustumInfo.frustumVertCount}`
        );
        if (frustumInfo.sampleNear.length > 0) {
          const n = frustumInfo.sampleNear;
          const f = frustumInfo.sampleFar;
          console.log(
            `[Persistence] DIAG shape #0 near[0..2]: ` +
            n.slice(0, 3).map((v: Vector2) => `(${v.x.toFixed(0)},${v.y.toFixed(0)})`).join(" ") +
            ` | far[0..2]: ` +
            f.slice(0, 3).map((v: Vector2) => `(${v.x.toFixed(0)},${v.y.toFixed(0)})`).join(" ")
          );
        }
      }

      const frustumOk = lightPath.op(frustumInfo.path, CK.PathOp.Difference);
      if (!frustumOk) frustumOpFails++;

      frustumInfo.path.delete();
    }

    fogPath.delete();
    shapeCount++;
  }

  console.log(
    `[Persistence] CanvasKit visibility: ${shapeCount} fog shapes subtracted ` +
    `(shapeOpFails=${shapeOpFails}, frustumOpFails=${frustumOpFails})`
  );

  // Convert the remaining path to polyline rings
  const commands = PathHelpers.skPathToPathCommands(lightPath);
  const polylines = PathHelpers.commandsToPolylines(CK, commands, 10);
  lightPath.delete();

  console.log(
    `[Persistence] Result: ${polylines.length} polylines, ` +
    `vertex counts: [${polylines.map((p) => p.length).join(", ")}]`
  );

  // Drop degenerate contours
  return polylines.filter((p) => p.length >= 3);
}

interface FrustumResult {
  path: SkPath;
  contourCount: number;
  nearVertCount: number;
  frustumVertCount: number;
  sampleNear: Vector2[];
  sampleFar: Vector2[];
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
 * Returns result with the path and diagnostics, or null if no valid contours.
 */
function buildShadowFrustum(
  CK: CanvasKit,
  shapePath: SkPath,
  origin: Vector2,
  farDist: number
): FrustumResult | null {
  const commands = PathHelpers.skPathToPathCommands(shapePath);
  const contours = PathHelpers.commandsToPolylines(CK, commands, 15);

  let hasContent = false;
  const frustumPath = new CK.Path();
  let contourCount = 0;
  let nearVertCount = 0;
  let frustumVertCount = 0;
  let sampleNear: Vector2[] = [];
  let sampleFar: Vector2[] = [];

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

    contourCount++;
    nearVertCount += verts.length;

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

    // Capture samples for diagnostics (first contour only)
    if (contourCount === 1) {
      sampleNear = verts.slice(0, 5);
      sampleFar = projected.slice(0, 5);
    }

    // Build frustum using moveTo/lineTo/close instead of addPoly
    // to rule out any addPoly flat-array interpretation issues
    frustumPath.moveTo(verts[0].x, verts[0].y);
    for (let i = 1; i < verts.length; i++) {
      frustumPath.lineTo(verts[i].x, verts[i].y);
    }
    for (let i = projected.length - 1; i >= 0; i--) {
      frustumPath.lineTo(projected[i].x, projected[i].y);
    }
    frustumPath.close();

    frustumVertCount += verts.length + projected.length;
    hasContent = true;
  }

  if (!hasContent) {
    frustumPath.delete();
    return null;
  }

  return {
    path: frustumPath,
    contourCount,
    nearVertCount,
    frustumVertCount,
    sampleNear,
    sampleFar,
  };
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
