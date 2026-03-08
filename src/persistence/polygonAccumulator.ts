import polygonClipping from "polygon-clipping";
import type { Pair, Polygon as PCPolygon, MultiPolygon as PCMultiPolygon } from "polygon-clipping";
import simplify from "simplify-js";
import type { Vector2 } from "@owlbear-rodeo/sdk";
import type { Ring } from "./types";

/**
 * The accumulated multi-polygon representing all areas revealed so far.
 * Uses polygon-clipping's coordinate format: number[][][]
 * MultiPolygon = Polygon[] where Polygon = Ring[] (outer ring + hole rings)
 * Ring = [number, number][]
 */
let accumulated: PCMultiPolygon | null = null;

/** Count of union operations since last simplification */
let unionsSinceSimplify = 0;

/**
 * Vertex budget thresholds.
 *
 * These control how aggressively the accumulator manages vertex count to
 * avoid destabilising OBR's native fog rasterisation, scene sync, and
 * memory usage. Each threshold triggers a different strategy:
 *
 * - SIMPLIFY_SOFT:  periodic low-tolerance simplification (imperceptible)
 * - SIMPLIFY_HARD:  aggressive simplification at higher tolerance
 * - REGION_SPLIT:   stop unioning and start a new disjoint region instead
 * - REJECT:         refuse to accumulate (the UI warns to reset)
 */
const SIMPLIFY_SOFT_VERTEX_COUNT = 1500;
const SIMPLIFY_HARD_VERTEX_COUNT = 3000;
const REGION_SPLIT_VERTEX_COUNT = 5000;
const REJECT_VERTEX_COUNT = 8000;

/** Simplify every N unions even if under threshold (keeps things tidy) */
const SIMPLIFY_INTERVAL = 10;

/** Douglas-Peucker tolerances in scene pixels */
const TOLERANCE_SOFT = 1.5;   // imperceptible
const TOLERANCE_HARD = 4;     // slightly visible at dungeon edges, acceptable

/** Result of an accumulate call, for the caller to react to */
export type AccumulateResult =
  | { status: "ok" }
  | { status: "simplified"; tolerance: number }
  | { status: "region_split" }
  | { status: "rejected"; vertexCount: number };

/**
 * Add a new visibility polygon to the accumulated area via boolean union.
 * Returns a status indicating what strategy was applied.
 */
export function accumulatePolygon(visPolygon: Ring): AccumulateResult {
  const currentCount = getTotalVertexCount();

  // Hard reject: accumulated polygon is too large to safely grow
  if (currentCount >= REJECT_VERTEX_COUNT) {
    return { status: "rejected", vertexCount: currentCount };
  }

  const newPoly = ringToPCPolygon(visPolygon);

  // Region split: skip union (which grows complexity) and add as separate polygon
  if (currentCount >= REGION_SPLIT_VERTEX_COUNT) {
    if (!accumulated) {
      accumulated = [newPoly];
    } else {
      accumulated.push(newPoly);
    }
    // Immediately simplify the new region
    simplifyAccumulated(TOLERANCE_HARD);
    return { status: "region_split" };
  }

  // Normal union
  if (!accumulated) {
    accumulated = [newPoly];
  } else {
    accumulated = polygonClipping.union(accumulated, newPoly);
  }

  unionsSinceSimplify++;

  // Aggressive simplification when approaching limits
  if (currentCount >= SIMPLIFY_HARD_VERTEX_COUNT) {
    simplifyAccumulated(TOLERANCE_HARD);
    unionsSinceSimplify = 0;
    return { status: "simplified", tolerance: TOLERANCE_HARD };
  }

  // Soft simplification: periodic or when crossing the soft threshold
  if (
    unionsSinceSimplify >= SIMPLIFY_INTERVAL ||
    getTotalVertexCount() > SIMPLIFY_SOFT_VERTEX_COUNT
  ) {
    simplifyAccumulated(TOLERANCE_SOFT);
    unionsSinceSimplify = 0;
    return { status: "simplified", tolerance: TOLERANCE_SOFT };
  }

  return { status: "ok" };
}

/**
 * Get the accumulated polygon as an array of OBR-compatible rings.
 * Returns null if nothing has been accumulated yet.
 *
 * The result is a multi-polygon: each entry is an outer ring,
 * potentially followed by hole rings. For the fog writer, we need
 * all rings as Path subpaths.
 */
export function getAccumulatedPolygon(): Ring[][] | null {
  if (!accumulated) return null;

  const result: Ring[][] = [];
  for (const polygon of accumulated) {
    const rings: Ring[] = [];
    for (const ring of polygon) {
      rings.push(pcRingToRing(ring));
    }
    result.push(rings);
  }
  return result;
}

/** Get the total vertex count across all accumulated polygons */
export function getTotalVertexCount(): number {
  if (!accumulated) return 0;
  let count = 0;
  for (const polygon of accumulated) {
    for (const ring of polygon) {
      count += ring.length;
    }
  }
  return count;
}

/** Reset the accumulator (clear all persistence data) */
export function resetAccumulator(): void {
  accumulated = null;
  unionsSinceSimplify = 0;
}

/**
 * Restore accumulated state from a previously saved set of rings.
 * Called on startup to restore from the existing fog item's geometry.
 */
export function restoreAccumulator(rings: Ring[][]): void {
  if (rings.length === 0) {
    accumulated = null;
    return;
  }

  accumulated = rings.map((polygonRings) =>
    polygonRings.map((ring) => ringToPCRing(ring))
  );
  unionsSinceSimplify = 0;
}

/**
 * Apply Douglas-Peucker simplification to all rings in the accumulated polygon.
 * Rings that simplify below 3 points are dropped (degenerate).
 */
function simplifyAccumulated(tolerance: number): void {
  if (!accumulated) return;

  accumulated = accumulated
    .map((polygon) =>
      polygon
        .map((ring) => {
          const points = ring.map(([x, y]) => ({ x, y }));
          const simplified = simplify(points, tolerance, true);
          return simplified.map((p): Pair => [p.x, p.y]);
        })
        .filter((ring) => ring.length >= 3)
    )
    .filter((polygon) => polygon.length > 0);

  if (accumulated.length === 0) {
    accumulated = null;
  }
}

/** Convert our Ring (Vector2[]) to a polygon-clipping Polygon (single outer ring, no holes) */
function ringToPCPolygon(ring: Ring): PCPolygon {
  return [ringToPCRing(ring)];
}

/** Convert our Ring (Vector2[]) to a polygon-clipping Ring ([number, number][]) */
function ringToPCRing(ring: Ring): Pair[] {
  return ring.map((p): Pair => [p.x, p.y]);
}

/** Convert a polygon-clipping Ring back to our Ring (Vector2[]) */
function pcRingToRing(pcRing: Pair[]): Ring {
  return pcRing.map(([x, y]): Vector2 => ({ x, y }));
}
