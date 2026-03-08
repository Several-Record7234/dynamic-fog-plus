import type { Vector2 } from "@owlbear-rodeo/sdk";

/** A polygon ring is a closed loop of 2D points (no duplicate closing vertex needed) */
export type Ring = Vector2[];

/**
 * A polygon that may contain holes.
 * polygon-clipping uses number[][][] (ring of [x,y] pairs) per polygon
 * and number[][][][] for multi-polygons.
 * We keep our own type for clarity within the persistence system.
 */
export type Polygon = Ring;

/** Multi-polygon: array of polygons, each with an outer ring and optional holes */
export type MultiPolygon = Ring[];

/** A wall segment defined by two endpoints in world space */
export interface WallSegment {
  a: Vector2;
  b: Vector2;
}

/** Tracked state for a single light-bearing token */
export interface TrackedToken {
  /** Scene item ID of the token */
  itemId: string;
  /** Last position where visibility was computed */
  lastComputedPosition: Vector2;
  /** Light attenuation radius at last computation */
  attenuationRadius: number;
  /** Light outer angle (360 = full circle, <360 = cone) */
  outerAngle: number;
  /** Light inner angle for cone falloff */
  innerAngle: number;
  /** Token rotation + light rotation offset in degrees */
  lightRotation: number;
}

/** Settings stored in scene metadata for persistence state */
export interface PersistenceSettings {
  /** Whether persistence tracking is active */
  enabled: boolean;
  /** Token IDs that are excluded from persistence tracking */
  excludedTokens: string[];
}

export const DEFAULT_PERSISTENCE_SETTINGS: PersistenceSettings = {
  enabled: false,
  excludedTokens: [],
};

/** Performance metrics published per computation cycle */
export interface PersistencePerf {
  /** Total time for the compute-and-accumulate cycle (ms) */
  totalMs: number;
  /** Time spent computing the visibility polygon (ms) */
  visMs: number;
  /** Time spent on polygon union (ms) */
  unionMs: number;
  /** Number of wall segments processed */
  wallCount: number;
  /** Current total vertex count */
  vertexCount: number;
  /** Accumulator strategy applied this cycle */
  status: "ok" | "simplified" | "region_split" | "rejected";
}

export const DEFAULT_PERSISTENCE_PERF: PersistencePerf = {
  totalMs: 0,
  visMs: 0,
  unionMs: 0,
  wallCount: 0,
  vertexCount: 0,
  status: "ok",
};
