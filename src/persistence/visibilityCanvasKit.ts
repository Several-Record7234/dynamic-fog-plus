import type { CanvasKit, Path as SkPath } from "canvaskit-wasm";
import type { Vector2, Item } from "@owlbear-rodeo/sdk";
import { isShape, MathM } from "@owlbear-rodeo/sdk";
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
  const farDist = radius * SHADOW_PROJECTION_FACTOR;

  for (const item of fogItems) {
    if (item.layer !== "FOG") continue;
    if (!isDrawing(item)) continue;
    if (PERSISTENCE_METADATA_KEY in item.metadata) continue;

    const drawing = item as Drawing;
    const fogPath = PathHelpers.drawingToSkPath(drawing, CK);
    if (!fogPath) continue;

    // Build the full visual boundary (fill + stroke) like WallHelpers does.
    // Without stroke, the frustum starts from the fill center line, leaving
    // a gap between the visual fog boundary and the shadow.
    const visualPath = buildVisualBoundary(CK, fogPath, drawing);

    const transform = MathM.fromItem(item);
    visualPath.transform(...transform);

    lightPath.op(visualPath, CK.PathOp.Difference);

    const frustumPath = buildShadowFrustum(CK, visualPath, origin, farDist);
    if (frustumPath) {
      lightPath.op(frustumPath, CK.PathOp.Difference);
      frustumPath.delete();
    }

    fogPath.delete();
    visualPath.delete();
    shapeCount++;
  }

  console.log(`[Persistence] CanvasKit visibility: ${shapeCount} fog shapes subtracted`);
  return lightPath;
}

/**
 * Build the full visual boundary of a fog drawing (fill + stroke).
 *
 * OBR renders fog shapes with both fill and stroke. The stroke extends
 * beyond the fill path by half the stroke width. If we only use the fill
 * path, the shadow frustum starts from the center line of the stroke,
 * leaving a visible gap between the fog shape edge and the shadow.
 *
 * Returns a NEW path — the caller must delete both it and the original fogPath.
 */
function buildVisualBoundary(
  CK: CanvasKit,
  fogPath: SkPath,
  drawing: Drawing
): SkPath {
  const sw = drawing.style.strokeWidth;
  const so = drawing.style.strokeOpacity;

  // No stroke or invisible stroke — just use the fill path
  if (!sw || sw <= 0 || !so || so <= 0) {
    return fogPath.copy();
  }

  // Create stroke outline (same logic as WallHelpers)
  const strokePath = fogPath.copy();
  strokePath.stroke({
    cap: isShape(drawing) ? CK.StrokeCap.Square : CK.StrokeCap.Round,
    join: isShape(drawing) ? CK.StrokeJoin.Miter : CK.StrokeJoin.Round,
    width: sw,
  });

  // Union fill + stroke to get the full visual boundary
  const hasFill = "fillOpacity" in drawing.style && drawing.style.fillOpacity > 0;
  if (hasFill) {
    const combined = fogPath.copy();
    combined.op(strokePath, CK.PathOp.Union);
    strokePath.delete();
    return combined;
  }

  // Stroke-only shape
  return strokePath;
}

/**
 * Build a shadow frustum path for a fog shape using per-edge quads.
 *
 * For each edge (Vi, Vi+1) of each contour, builds a quadrilateral:
 *   Vi → Vi+1 → Vi+1' → Vi'
 * where Vi' = origin + (Vi − origin) × (farDist / |Vi − origin|)
 *
 * Individual quads are always simple (non-self-intersecting). Overlapping
 * quads are resolved by calling path.simplify() which merges them into a
 * single clean outline.  This avoids the self-intersection problem that
 * occurs when tracing all near vertices then all far vertices as one polygon
 * (far vertices cross when the shape subtends a large angle from the light).
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

    // Build one quad per edge: Vi → Vi+1 → Vi+1' → Vi'
    for (let i = 0; i < verts.length; i++) {
      const j = (i + 1) % verts.length;
      frustumPath.moveTo(verts[i].x, verts[i].y);
      frustumPath.lineTo(verts[j].x, verts[j].y);
      frustumPath.lineTo(projected[j].x, projected[j].y);
      frustumPath.lineTo(projected[i].x, projected[i].y);
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
