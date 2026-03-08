import type { CanvasKit } from "canvaskit-wasm";
import type { Vector2, Item } from "@owlbear-rodeo/sdk";
import { MathM } from "@owlbear-rodeo/sdk";
import { PathHelpers } from "../background/util/PathHelpers";
import { isDrawing } from "../types/Drawing";
import type { Drawing } from "../types/Drawing";
import type { Ring } from "./types";
import { PERSISTENCE_METADATA_KEY } from "./fogWriter";

/**
 * Compute visibility using CanvasKit path boolean operations.
 *
 * Creates a circle (or sector for cones) at the light position, then
 * subtracts every FOG-layer shape from it.  The remainder is the area
 * visible from the light — everything within range that isn't behind
 * a fog shape.
 *
 * This replaces the custom angular-sweep algorithm which had robustness
 * issues at wall corners and junctions (gaps in stroke-outline geometry
 * allowed rays to leak through).
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

  // Subtract each FOG drawing's filled area from the light shape
  let subtracted = 0;
  for (const item of fogItems) {
    if (item.layer !== "FOG") continue;
    if (!isDrawing(item)) continue;
    if (PERSISTENCE_METADATA_KEY in item.metadata) continue;

    const fogPath = PathHelpers.drawingToSkPath(item as Drawing, CK);
    if (!fogPath) continue;

    // Transform local-space path to world space
    const transform = MathM.fromItem(item);
    fogPath.transform(...transform);

    lightPath.op(fogPath, CK.PathOp.Difference);
    fogPath.delete();
    subtracted++;
  }

  console.log(
    `[Persistence] CanvasKit visibility: subtracted ${subtracted} fog shapes from light circle`
  );

  // Convert the remaining path to polyline rings
  const commands = PathHelpers.skPathToPathCommands(lightPath);
  const polylines = PathHelpers.commandsToPolylines(CK, commands, 10);
  lightPath.delete();

  // Drop degenerate contours
  return polylines.filter((p) => p.length >= 3);
}

/**
 * Add a pie-slice sector to a CanvasKit path.
 *
 * OBR rotation convention: 0 = up/north, clockwise positive.
 * We convert to standard math angles (0 = right/east, CCW positive).
 */
function addSectorToPath(
  path: InstanceType<CanvasKit["Path"]>,
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
