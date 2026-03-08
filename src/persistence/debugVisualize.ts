import OBR, { buildPath, Command, isShape } from "@owlbear-rodeo/sdk";
import type { CanvasKit } from "canvaskit-wasm";
import type { Vector2, Item, PathCommand, Path } from "@owlbear-rodeo/sdk";
import { MathM } from "@owlbear-rodeo/sdk";
import { PathHelpers } from "../background/util/PathHelpers";
import { isDrawing } from "../types/Drawing";
import type { Drawing } from "../types/Drawing";
import { getPluginId } from "../util/getPluginId";
import { PERSISTENCE_METADATA_KEY } from "./fogWriter";

const DEBUG_METADATA_KEY = getPluginId("debug-vis");

/** Colours cycled per fog shape */
const COLORS = [
  "#FF0000", // red
  "#00FF00", // green
  "#0000FF", // blue
  "#FF00FF", // magenta
  "#FFFF00", // yellow
  "#00FFFF", // cyan
];

const SHADOW_PROJECTION_FACTOR = 3;

/**
 * Draw coloured debug shapes on the DRAWING layer so the GM can
 * visually inspect what the shadow frustum algorithm produces.
 *
 * Creates:
 *  - A semi-transparent circle for the light area (white)
 *  - Per-fog-shape: the raw edge quads (faint fill, coloured stroke)
 *  - Per-fog-shape: the simplified frustum (stronger fill, white stroke)
 */
export async function drawDebugShapes(
  CK: CanvasKit,
  origin: Vector2,
  radius: number,
  fogItems: Item[],
  _outerAngle: number = 360,
  _rotationDeg: number = 0
): Promise<void> {
  await removeDebugShapes();

  const itemsToAdd: Path[] = [];
  const farDist = radius * SHADOW_PROJECTION_FACTOR;

  // 1. Light circle outline
  const lightCommands: PathCommand[] = [];
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const x = origin.x + Math.cos(a) * radius;
    const y = origin.y + Math.sin(a) * radius;
    if (i === 0) lightCommands.push([Command.MOVE, x, y]);
    else lightCommands.push([Command.LINE, x, y]);
  }
  lightCommands.push([Command.CLOSE]);

  itemsToAdd.push(
    buildPath()
      .commands(lightCommands)
      .layer("DRAWING")
      .fillColor("#FFFFFF")
      .fillOpacity(0.15)
      .strokeColor("#FFFFFF")
      .strokeWidth(2)
      .strokeOpacity(0.5)
      .name("DEBUG: Light circle")
      .metadata({
        [DEBUG_METADATA_KEY]: true,
        [getPluginId("debug-info")]: {
          kind: "light-circle",
          origin,
          radius,
        },
      })
      .build()
  );

  // 2. Per-shape frustums
  let colorIdx = 0;
  for (const item of fogItems) {
    if (item.layer !== "FOG") continue;
    if (!isDrawing(item)) continue;
    if (PERSISTENCE_METADATA_KEY in item.metadata) continue;

    const drawing = item as Drawing;
    const fogPath = PathHelpers.drawingToSkPath(drawing, CK);
    if (!fogPath) continue;

    // Build visual boundary (fill + stroke) to match the actual visibility code
    const visualPath = buildDebugVisualBoundary(CK, fogPath, drawing);
    fogPath.delete();

    const transform = MathM.fromItem(item);
    visualPath.transform(...transform);

    const commands = PathHelpers.skPathToPathCommands(visualPath);
    const contours = PathHelpers.commandsToPolylines(CK, commands, 15);

    // Diagnostic: log item position vs. first vertex of visual boundary
    if (contours.length > 0 && contours[0].length > 0) {
      const firstVert = contours[0][0];
      console.log(
        `[DEBUG VIS] Shape #${colorIdx} "${item.name || item.id.slice(0, 8)}"` +
        ` pos=(${item.position.x.toFixed(1)}, ${item.position.y.toFixed(1)})` +
        ` firstVert=(${firstVert.x.toFixed(1)}, ${firstVert.y.toFixed(1)})` +
        ` transform=[${transform.map(v => v.toFixed(2)).join(", ")}]` +
        ` contours=${contours.length} verts=${contours.map(c => c.length).join(",")}`
      );
    }

    const color = COLORS[colorIdx % COLORS.length];

    // Draw the visual boundary itself (bright outline, no fill)
    // so we can see if it aligns with the actual fog shape on screen
    const boundaryCommands: PathCommand[] = [];
    for (const poly of contours) {
      if (poly.length < 3) continue;
      boundaryCommands.push([Command.MOVE, poly[0].x, poly[0].y]);
      for (let i = 1; i < poly.length; i++) {
        boundaryCommands.push([Command.LINE, poly[i].x, poly[i].y]);
      }
      boundaryCommands.push([Command.CLOSE]);
    }
    if (boundaryCommands.length > 0) {
      itemsToAdd.push(
        buildPath()
          .commands(boundaryCommands)
          .layer("DRAWING")
          .fillColor(color)
          .fillOpacity(0)
          .strokeColor(color)
          .strokeWidth(3)
          .strokeOpacity(1)
          .name(`DEBUG: Visual boundary #${colorIdx} (${item.name || item.id.slice(0, 8)})`)
          .metadata({
            [DEBUG_METADATA_KEY]: true,
            [getPluginId("debug-info")]: {
              kind: "visual-boundary",
              shapeIndex: colorIdx,
              sourceItemId: item.id,
              sourceItemName: item.name,
              contourCount: contours.length,
              vertexCounts: contours.map(c => c.length),
            },
          })
          .build()
      );
    }

    // Build edge quads for visualization
    const quadCommands: PathCommand[] = [];
    const allVerts: { verts: Vector2[]; projected: Vector2[] }[] = [];

    for (let verts of contours) {
      if (verts.length < 3) continue;
      const first = verts[0];
      const last = verts[verts.length - 1];
      if ((last.x - first.x) ** 2 + (last.y - first.y) ** 2 < 1) {
        verts = verts.slice(0, -1);
      }
      if (verts.length < 3) continue;

      const projected = verts.map((v) => {
        const dx = v.x - origin.x;
        const dy = v.y - origin.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.01) return { x: origin.x + farDist, y: origin.y };
        const scale = farDist / len;
        return { x: origin.x + dx * scale, y: origin.y + dy * scale };
      });

      allVerts.push({ verts, projected });

      for (let i = 0; i < verts.length; i++) {
        const j = (i + 1) % verts.length;
        quadCommands.push([Command.MOVE, verts[i].x, verts[i].y]);
        quadCommands.push([Command.LINE, verts[j].x, verts[j].y]);
        quadCommands.push([Command.LINE, projected[j].x, projected[j].y]);
        quadCommands.push([Command.LINE, projected[i].x, projected[i].y]);
        quadCommands.push([Command.CLOSE]);
      }
    }

    // Raw quads (faint)
    if (quadCommands.length > 0) {
      itemsToAdd.push(
        buildPath()
          .commands(quadCommands)
          .fillRule("evenodd")
          .layer("DRAWING")
          .fillColor(color)
          .fillOpacity(0.12)
          .strokeColor(color)
          .strokeWidth(1)
          .strokeOpacity(0.4)
          .name(`DEBUG: Raw quads #${colorIdx} (${item.name || item.id.slice(0, 8)})`)
          .metadata({
            [DEBUG_METADATA_KEY]: true,
            [getPluginId("debug-info")]: {
              kind: "raw-quads",
              shapeIndex: colorIdx,
              sourceItemId: item.id,
              sourceItemName: item.name,
              quadCount: allVerts.reduce((s, v) => s + v.verts.length, 0),
              contourCount: allVerts.length,
            },
          })
          .build()
      );
    }

    // Simplified frustum (what CanvasKit actually subtracts)
    const frustumPath = new CK.Path();
    for (const { verts, projected } of allVerts) {
      for (let i = 0; i < verts.length; i++) {
        const j = (i + 1) % verts.length;
        frustumPath.moveTo(verts[i].x, verts[i].y);
        frustumPath.lineTo(verts[j].x, verts[j].y);
        frustumPath.lineTo(projected[j].x, projected[j].y);
        frustumPath.lineTo(projected[i].x, projected[i].y);
        frustumPath.close();
      }
    }
    frustumPath.simplify();

    const simplifiedCommands = PathHelpers.skPathToPathCommands(frustumPath);
    const simplifiedPolylines = PathHelpers.commandsToPolylines(CK, simplifiedCommands, 10);
    frustumPath.delete();

    const simplifiedPathCommands: PathCommand[] = [];
    for (const poly of simplifiedPolylines) {
      if (poly.length < 3) continue;
      simplifiedPathCommands.push([Command.MOVE, poly[0].x, poly[0].y]);
      for (let i = 1; i < poly.length; i++) {
        simplifiedPathCommands.push([Command.LINE, poly[i].x, poly[i].y]);
      }
      simplifiedPathCommands.push([Command.CLOSE]);
    }

    if (simplifiedPathCommands.length > 0) {
      itemsToAdd.push(
        buildPath()
          .commands(simplifiedPathCommands)
          .layer("DRAWING")
          .fillColor(color)
          .fillOpacity(0.3)
          .strokeColor("#FFFFFF")
          .strokeWidth(2)
          .strokeOpacity(0.8)
          .name(`DEBUG: Simplified frustum #${colorIdx} (${item.name || item.id.slice(0, 8)})`)
          .metadata({
            [DEBUG_METADATA_KEY]: true,
            [getPluginId("debug-info")]: {
              kind: "simplified-frustum",
              shapeIndex: colorIdx,
              sourceItemId: item.id,
              sourceItemName: item.name,
              polylineCount: simplifiedPolylines.length,
              vertexCount: simplifiedPolylines.reduce((s, p) => s + p.length, 0),
            },
          })
          .build()
      );
    }

    visualPath.delete();
    colorIdx++;
  }

  if (itemsToAdd.length > 0) {
    await OBR.scene.items.addItems(itemsToAdd);
    console.log(`[Persistence DEBUG] Added ${itemsToAdd.length} debug shapes`);
  }
}

/** Build the visual boundary (fill + stroke) for a fog drawing */
function buildDebugVisualBoundary(
  CK: CanvasKit,
  fogPath: import("canvaskit-wasm").Path,
  drawing: Drawing
): import("canvaskit-wasm").Path {
  const sw = drawing.style.strokeWidth;
  const so = drawing.style.strokeOpacity;
  if (!sw || sw <= 0 || !so || so <= 0) {
    return fogPath.copy();
  }
  const strokePath = fogPath.copy();
  strokePath.stroke({
    cap: isShape(drawing) ? CK.StrokeCap.Square : CK.StrokeCap.Round,
    join: isShape(drawing) ? CK.StrokeJoin.Miter : CK.StrokeJoin.Round,
    width: sw,
  });
  if ("fillOpacity" in drawing.style && drawing.style.fillOpacity > 0) {
    const combined = fogPath.copy();
    combined.op(strokePath, CK.PathOp.Union);
    strokePath.delete();
    return combined;
  }
  return strokePath;
}

/** Remove all debug visualization shapes from the scene */
export async function removeDebugShapes(): Promise<void> {
  const items = await OBR.scene.items.getItems((item) => {
    return DEBUG_METADATA_KEY in item.metadata;
  });
  if (items.length > 0) {
    await OBR.scene.items.deleteItems(items.map((i) => i.id));
    console.log(`[Persistence DEBUG] Removed ${items.length} debug shapes`);
  }
}
