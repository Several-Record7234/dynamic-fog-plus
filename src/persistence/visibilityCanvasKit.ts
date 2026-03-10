import type { CanvasKit, Path as SkPath } from "canvaskit-wasm";
import type { Vector2, Item } from "@owlbear-rodeo/sdk";
import { MathM } from "@owlbear-rodeo/sdk";
import { PathHelpers } from "../background/util/PathHelpers";
import { isDrawing } from "../types/Drawing";
import type { Drawing } from "../types/Drawing";
import { PERSISTENCE_METADATA_KEY } from "./fogWriter";

/**
 * How far beyond the light radius to project shadow vertices.
 * 3× ensures the shadow frustum extends well past the boundary circle.
 */
const SHADOW_PROJECTION_FACTOR = 3;

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

    const drawing = item as Drawing;
    const fogPath = PathHelpers.drawingToSkPath(drawing, CK);
    if (!fogPath) continue;

    // Use the fill path directly for the visual boundary.
    // WallHelpers expands with stroke() but that triggers CanvasKit dash()
    // errors on some fog shapes.  The fill-only boundary is at most half a
    // stroke width smaller — negligible given the radius scaling we apply.
    const visualPath = fogPath.copy();

    const transform = MathM.fromItem(item);
    visualPath.transform(...transform);

    if (!lightPath.op(visualPath, CK.PathOp.Difference)) {
      shapeOpFails++;
      console.warn(`[Persistence] PathOp.Difference FAILED for shape "${item.name || item.id.slice(0, 8)}"`);
    }

    const frustumPath = buildShadowFrustum(CK, visualPath, origin, farDist);
    if (frustumPath) {
      if (!lightPath.op(frustumPath, CK.PathOp.Difference)) {
        frustumOpFails++;
        console.warn(`[Persistence] PathOp.Difference FAILED for frustum of "${item.name || item.id.slice(0, 8)}"`);
      }
      frustumPath.delete();
    }

    fogPath.delete();
    visualPath.delete();
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

    // Project each vertex away from the light source
    const projected = verts.map((v) => projectVertex(v, origin, farDist));

    // Build one quad per edge with consistent winding direction.
    // Edges on opposite sides of the shape naturally produce quads with
    // opposite winding.  We compute signed area and reverse vertex order
    // for CCW quads so all quads are CW (positive signed area in screen
    // coords).  This ensures overlapping quads accumulate winding rather
    // than cancelling.
    for (let i = 0; i < verts.length; i++) {
      const j = (i + 1) % verts.length;
      const a = verts[i], b = verts[j], c = projected[j], d = projected[i];
      const sa = quadSignedArea2x(a, b, c, d);
      if (sa >= 0) {
        frustumPath.moveTo(a.x, a.y);
        frustumPath.lineTo(b.x, b.y);
        frustumPath.lineTo(c.x, c.y);
        frustumPath.lineTo(d.x, d.y);
      } else {
        frustumPath.moveTo(a.x, a.y);
        frustumPath.lineTo(d.x, d.y);
        frustumPath.lineTo(c.x, c.y);
        frustumPath.lineTo(b.x, b.y);
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
 * Compute 2× the signed area of quadrilateral ABCD (shoelace formula).
 * Positive = clockwise in screen coordinates (y-down).
 */
function quadSignedArea2x(a: Vector2, b: Vector2, c: Vector2, d: Vector2): number {
  return (
    (a.x * b.y - b.x * a.y) +
    (b.x * c.y - c.x * b.y) +
    (c.x * d.y - d.x * c.y) +
    (d.x * a.y - a.x * d.y)
  );
}

/** Project a vertex away from the light source to a fixed distance */
function projectVertex(v: Vector2, origin: Vector2, farDist: number): Vector2 {
  const dx = v.x - origin.x;
  const dy = v.y - origin.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) {
    return { x: origin.x + farDist, y: origin.y };
  }
  const scale = farDist / len;
  return { x: origin.x + dx * scale, y: origin.y + dy * scale };
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
