/**
 * Worker pool for parallel fog-shape visibility computation.
 *
 * Manages N Web Workers, each with its own CanvasKit WASM instance.
 * Distributes pre-processed fog shapes across workers in round-robin
 * batches, collects their union results, and returns them for the
 * main thread to subtract from the light circle.
 */
import type { CanvasKit } from "canvaskit-wasm";
import type { Item, Vector2 } from "@owlbear-rodeo/sdk";
import { MathM } from "@owlbear-rodeo/sdk";
import { PathHelpers } from "../background/util/PathHelpers";
import { isDrawing } from "../types/Drawing";
import type { Drawing } from "../types/Drawing";
import { PERSISTENCE_METADATA_KEY } from "./fogWriter";
import type { PreparedFogShape } from "./workers/visibilityWorker";

export type { PreparedFogShape };

/** Minimum fog shapes to justify worker overhead.
 *  With 4 workers, each needs enough shapes for the parallelism to
 *  outweigh message passing + Path.MakeFromCmds reconstruction cost. */
const MIN_SHAPES_FOR_WORKERS = 12;

interface PendingRequest {
  resolve: (cmds: Float32Array) => void;
  reject: (err: Error) => void;
}

interface ManagedWorker {
  worker: Worker;
  ready: boolean;
  pending: Map<number, PendingRequest>;
}

export class VisibilityWorkerPool {
  private workers: ManagedWorker[] = [];
  private nextRequestId = 0;
  private initPromise: Promise<void> | null = null;

  /** Number of workers in the pool */
  get size(): number {
    return this.workers.length;
  }

  /** Whether all workers are initialized and ready */
  get ready(): boolean {
    return this.workers.length > 0 && this.workers.every((w) => w.ready);
  }

  /**
   * Initialize the worker pool.
   *
   * @param wasmUrl - URL to the canvaskit.wasm binary (from `?url` import)
   * @param poolSize - Number of workers (defaults to cores-2, clamped 2..4)
   */
  async init(wasmUrl: string, poolSize?: number): Promise<void> {
    if (this.initPromise) return this.initPromise;

    const size = poolSize ?? Math.min(
      Math.max((navigator.hardwareConcurrency ?? 4) - 2, 2),
      4
    );

    this.initPromise = this.createWorkers(size, wasmUrl);
    return this.initPromise;
  }

  private async createWorkers(count: number, wasmUrl: string): Promise<void> {
    const readyPromises: Promise<void>[] = [];

    for (let i = 0; i < count; i++) {
      const worker = new Worker(
        new URL("./workers/visibilityWorker.ts", import.meta.url),
        { type: "module" }
      );

      const managed: ManagedWorker = {
        worker,
        ready: false,
        pending: new Map(),
      };

      const readyPromise = new Promise<void>((resolve) => {
        const onMessage = (e: MessageEvent) => {
          const msg = e.data;
          if (msg.type === "ready") {
            managed.ready = true;
            resolve();
          } else if (msg.type === "result") {
            const pending = managed.pending.get(msg.id);
            if (pending) {
              managed.pending.delete(msg.id);
              pending.resolve(msg.cmds);
            }
          }
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", (err) => {
          console.error("[WorkerPool] Worker error:", err);
          // Reject all pending requests
          for (const [, pending] of managed.pending) {
            pending.reject(new Error("Worker error"));
          }
          managed.pending.clear();
        });
      });

      readyPromises.push(readyPromise);
      this.workers.push(managed);

      // Send init message
      worker.postMessage({ type: "init", wasmUrl });
    }

    await Promise.all(readyPromises);
    console.log(`[WorkerPool] ${count} workers ready`);
  }

  /**
   * Distribute shapes across workers and collect results.
   * Returns an array of Float32Arrays (one per worker that had shapes).
   */
  async computeBatches(
    shapes: PreparedFogShape[],
    origin: Vector2,
    farDist: number
  ): Promise<Float32Array[]> {
    if (!this.ready || shapes.length === 0) return [];

    const workerCount = this.workers.length;
    const batchSize = Math.ceil(shapes.length / workerCount);

    const promises: Promise<Float32Array>[] = [];

    for (let i = 0; i < workerCount; i++) {
      const start = i * batchSize;
      if (start >= shapes.length) break;

      const batch = shapes.slice(start, start + batchSize);
      const id = this.nextRequestId++;
      const managed = this.workers[i];

      const promise = new Promise<Float32Array>((resolve, reject) => {
        managed.pending.set(id, { resolve, reject });
      });

      managed.worker.postMessage({
        type: "compute",
        id,
        shapes: batch,
        originX: origin.x,
        originY: origin.y,
        farDist,
      });

      promises.push(promise);
    }

    return Promise.all(promises);
  }

  /** Terminate all workers */
  destroy(): void {
    for (const { worker, pending } of this.workers) {
      for (const [, p] of pending) {
        p.reject(new Error("Pool destroyed"));
      }
      worker.terminate();
    }
    this.workers = [];
    this.initPromise = null;
  }
}

/**
 * Pre-process fog items into worker-ready shapes.
 * Called on the main thread when the fog item cache changes.
 *
 * Extracts PathCommands (as flat number[] from toCmds) and polyline
 * contour vertices for each fog shape, so workers can rebuild SkPaths
 * and compute frustums without needing PathHelpers or OBR SDK.
 */
export function prepareFogShapes(
  CK: CanvasKit,
  fogItems: Item[]
): PreparedFogShape[] {
  const result: PreparedFogShape[] = [];

  for (const item of fogItems) {
    if (item.layer !== "FOG") continue;
    if (!isDrawing(item)) continue;
    if (PERSISTENCE_METADATA_KEY in item.metadata) continue;

    const drawing = item as Drawing;
    const fogPath = PathHelpers.drawingToSkPath(drawing, CK);
    if (!fogPath) continue;

    // Transform in place
    fogPath.transform(...MathM.fromItem(item));

    // Extract flat commands for Path.MakeFromCmds
    const rawCmds = fogPath.toCmds();
    const pathCmds = rawCmds ? Array.from(rawCmds) : [];

    // Extract polyline contours for frustum building
    const pathCommands = PathHelpers.skPathToPathCommands(fogPath);
    const polylines = PathHelpers.commandsToPolylines(CK, pathCommands, 15);

    const contours: number[][] = [];
    for (let verts of polylines) {
      // Strip duplicate closing vertex
      if (verts.length > 0) {
        const first = verts[0];
        const last = verts[verts.length - 1];
        if ((last.x - first.x) ** 2 + (last.y - first.y) ** 2 < 1) {
          verts = verts.slice(0, -1);
        }
      }
      if (verts.length < 3) continue;
      // Flatten to [x0,y0, x1,y1, ...]
      const flat = new Array(verts.length * 2);
      for (let i = 0; i < verts.length; i++) {
        flat[i * 2] = verts[i].x;
        flat[i * 2 + 1] = verts[i].y;
      }
      contours.push(flat);
    }

    fogPath.delete();

    if (pathCmds.length > 0) {
      result.push({ pathCmds, contours });
    }
  }

  return result;
}

/**
 * Whether the pool should be used for this computation.
 * Returns false if pool isn't ready or there are too few shapes
 * for the worker overhead to pay off.
 */
export function shouldUseWorkers(
  pool: VisibilityWorkerPool | null,
  shapeCount: number
): boolean {
  return pool !== null && pool.ready && shapeCount >= MIN_SHAPES_FOR_WORKERS;
}
