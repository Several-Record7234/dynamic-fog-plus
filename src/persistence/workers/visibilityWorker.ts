/**
 * Web Worker for parallel fog-shape subtraction computation.
 *
 * Each worker loads its own CanvasKit WASM instance and processes a batch
 * of pre-processed fog shapes: rebuilds SkPaths, builds shadow frustums,
 * unions everything together, and returns the combined subtraction shape
 * as a flat Float32Array (CanvasKit toCmds format) for zero-parse transfer.
 */
import CanvasKitInit from "canvaskit-wasm/bin/full/canvaskit";
import type { CanvasKit, Path as SkPath } from "canvaskit-wasm";

let CK: CanvasKit | null = null;

export interface PreparedFogShape {
  /** Flat CanvasKit toCmds() output for the transformed fog shape */
  pathCmds: number[];
  /** Pre-flattened contour vertices: each contour is [x0,y0, x1,y1, ...] */
  contours: number[][];
}

export interface ComputeMessage {
  type: "compute";
  id: number;
  shapes: PreparedFogShape[];
  originX: number;
  originY: number;
  farDist: number;
}

export interface InitMessage {
  type: "init";
  wasmUrl: string;
}

export interface ReadyMessage {
  type: "ready";
}

export interface ResultMessage {
  type: "result";
  id: number;
  /** Flat toCmds() output — transferred, not copied */
  cmds: Float32Array;
}

type WorkerMessage = InitMessage | ComputeMessage;

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    CK = await CanvasKitInit({ locateFile: () => msg.wasmUrl });
    (self as unknown as Worker).postMessage({ type: "ready" } satisfies ReadyMessage);
    return;
  }

  if (msg.type === "compute") {
    if (!CK) {
      const empty = new Float32Array(0);
      (self as unknown as Worker).postMessage(
        { type: "result", id: msg.id, cmds: empty } satisfies ResultMessage,
        [empty.buffer]
      );
      return;
    }

    const cmds = computeBatch(CK, msg);
    (self as unknown as Worker).postMessage(
      { type: "result", id: msg.id, cmds } satisfies ResultMessage,
      [cmds.buffer] // transfer, not copy
    );
  }
};

function computeBatch(CK: CanvasKit, req: ComputeMessage): Float32Array {
  const originX = req.originX;
  const originY = req.originY;
  const farDist = req.farDist;

  let combined: SkPath | null = null;

  for (const shape of req.shapes) {
    // Rebuild SkPath from flat commands
    const shapePath = CK.Path.MakeFromCmds(shape.pathCmds);
    if (!shapePath) continue;

    // Union shape into combined
    if (!combined) {
      combined = shapePath;
    } else {
      if (!combined.op(shapePath, CK.PathOp.Union)) {
        console.warn("[Worker] PathOp.Union failed for shape");
      }
      shapePath.delete();
    }

    // Build and union the shadow frustum
    const frustumPath = buildFrustumFromContours(
      CK, shape.contours, originX, originY, farDist
    );
    if (frustumPath) {
      if (!combined) {
        combined = frustumPath;
      } else {
        if (!combined.op(frustumPath, CK.PathOp.Union)) {
          console.warn("[Worker] PathOp.Union failed for frustum");
        }
        frustumPath.delete();
      }
    }
  }

  if (!combined) return new Float32Array(0);

  const result = combined.toCmds();
  combined.delete();
  return result ?? new Float32Array(0);
}

/**
 * Build a shadow frustum path from pre-extracted polyline contours.
 * Same algorithm as visibilityCanvasKit.ts buildShadowFrustum, but
 * operates on flat [x0,y0,x1,y1,...] vertex arrays.
 */
function buildFrustumFromContours(
  CK: CanvasKit,
  contours: number[][],
  originX: number,
  originY: number,
  farDist: number
): SkPath | null {
  let hasContent = false;
  const frustumPath = new CK.Path();

  for (const flat of contours) {
    const vertCount = flat.length >> 1; // divide by 2
    if (vertCount < 3) continue;

    for (let i = 0; i < vertCount; i++) {
      const j = (i + 1) % vertCount;
      const ax = flat[i * 2], ay = flat[i * 2 + 1];
      const bx = flat[j * 2], by = flat[j * 2 + 1];

      // Project vertex i away from origin
      const dax = ax - originX, day = ay - originY;
      const lenA = Math.sqrt(dax * dax + day * day);
      const sA = lenA < 0.01 ? farDist : farDist / lenA;
      const dx = originX + dax * sA, dy = originY + day * sA;

      // Project vertex j away from origin
      const dbx = bx - originX, dby = by - originY;
      const lenB = Math.sqrt(dbx * dbx + dby * dby);
      const sB = lenB < 0.01 ? farDist : farDist / lenB;
      const cx = originX + dbx * sB, cy = originY + dby * sB;

      // Signed area — positive = CW in screen coords
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

  frustumPath.simplify();
  return frustumPath;
}
