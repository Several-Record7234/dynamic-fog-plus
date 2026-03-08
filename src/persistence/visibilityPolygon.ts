import type { Vector2 } from "@owlbear-rodeo/sdk";
import type { Ring, WallSegment } from "./types";

const TWO_PI = Math.PI * 2;
const EPSILON = 1e-6;

/**
 * Compute a visibility polygon from a given origin against a set of wall segments.
 *
 * Uses the angular sweep algorithm:
 * 1. Collect all wall segment endpoints within range.
 * 2. Sort them by angle from the origin.
 * 3. For each endpoint, cast rays at angle-epsilon, angle, and angle+epsilon.
 * 4. Find the nearest wall intersection for each ray.
 * 5. Output the visibility polygon as a ring of vertices.
 *
 * @param origin - The light source position in world space
 * @param radius - The attenuation radius of the light
 * @param walls - Wall segments in world space
 * @param outerAngle - The light's outer cone angle in degrees (360 = full circle)
 * @param rotationDeg - The light's rotation in degrees (0 = right/east)
 * @returns A ring of vertices representing the visible area
 */
export function computeVisibilityPolygon(
  origin: Vector2,
  radius: number,
  walls: WallSegment[],
  outerAngle: number = 360,
  rotationDeg: number = 0
): Ring {
  const radiusSq = radius * radius;

  // Filter walls to those that could intersect the light's range
  const relevantWalls = walls.filter((w) =>
    segmentIntersectsCircle(w.a, w.b, origin, radiusSq)
  );

  // Add a bounding circle as wall segments to clip the visibility at the light's range
  const boundarySegments = createBoundarySegments(origin, radius, 64);
  const allWalls = [...relevantWalls, ...boundarySegments];

  // Collect angles from all endpoints of all relevant walls.
  // No range filter — walls already passed segmentIntersectsCircle, so even
  // distant endpoints must generate rays to ensure the sweep doesn't miss
  // wall segments that cross through the light range.
  const angles: number[] = [];
  for (const wall of allWalls) {
    const a1 = Math.atan2(wall.a.y - origin.y, wall.a.x - origin.x);
    angles.push(a1 - EPSILON, a1, a1 + EPSILON);
    const a2 = Math.atan2(wall.b.y - origin.y, wall.b.x - origin.x);
    angles.push(a2 - EPSILON, a2, a2 + EPSILON);
  }

  // Sort angles
  angles.sort((a, b) => a - b);

  // Cast rays and find intersections
  const points: Vector2[] = [];
  for (const angle of angles) {
    const ray = {
      x: Math.cos(angle),
      y: Math.sin(angle),
    };

    let closestDist = Infinity;
    let closestPoint: Vector2 | null = null;

    for (const wall of allWalls) {
      const intersection = raySegmentIntersection(origin, ray, wall.a, wall.b);
      if (intersection !== null && intersection.dist < closestDist) {
        closestDist = intersection.dist;
        closestPoint = intersection.point;
      }
    }

    if (closestPoint) {
      // Deduplicate: skip if too close to the previous point
      if (points.length > 0) {
        const prev = points[points.length - 1];
        const dx = closestPoint.x - prev.x;
        const dy = closestPoint.y - prev.y;
        if (dx * dx + dy * dy < 0.01) {
          continue;
        }
      }
      points.push(closestPoint);
    }
  }

  // If the light is a cone, clip the polygon to the cone sector
  if (outerAngle < 360) {
    return clipToCone(points, origin, radius, outerAngle, rotationDeg);
  }

  return points;
}

/**
 * Create boundary segments approximating a circle around the origin.
 * These ensure the visibility polygon is clipped to the light's range.
 */
function createBoundarySegments(
  origin: Vector2,
  radius: number,
  numSegments: number
): WallSegment[] {
  const segments: WallSegment[] = [];
  const angleStep = TWO_PI / numSegments;

  for (let i = 0; i < numSegments; i++) {
    const a1 = i * angleStep;
    const a2 = (i + 1) * angleStep;
    segments.push({
      a: {
        x: origin.x + Math.cos(a1) * radius,
        y: origin.y + Math.sin(a1) * radius,
      },
      b: {
        x: origin.x + Math.cos(a2) * radius,
        y: origin.y + Math.sin(a2) * radius,
      },
    });
  }

  return segments;
}

/**
 * Check if a line segment intersects or is inside a circle.
 */
function segmentIntersectsCircle(
  a: Vector2,
  b: Vector2,
  center: Vector2,
  radiusSq: number
): boolean {
  // Check if either endpoint is inside the circle
  const da = (a.x - center.x) ** 2 + (a.y - center.y) ** 2;
  const db = (b.x - center.x) ** 2 + (b.y - center.y) ** 2;
  if (da <= radiusSq || db <= radiusSq) return true;

  // Check if the segment passes through the circle
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - center.x;
  const fy = a.y - center.y;

  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - radiusSq;

  let discriminant = B * B - 4 * A * C;
  if (discriminant < 0) return false;

  discriminant = Math.sqrt(discriminant);
  const t1 = (-B - discriminant) / (2 * A);
  const t2 = (-B + discriminant) / (2 * A);

  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}

/**
 * Find the intersection of a ray with a line segment.
 * Returns the intersection point and distance, or null if no intersection.
 */
function raySegmentIntersection(
  origin: Vector2,
  ray: Vector2,
  a: Vector2,
  b: Vector2
): { point: Vector2; dist: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  const denom = ray.x * dy - ray.y * dx;
  if (Math.abs(denom) < EPSILON) return null;

  const t2 =
    (ray.x * (a.y - origin.y) - ray.y * (a.x - origin.x)) / denom;
  if (t2 < 0 || t2 > 1) return null;

  const t1 =
    (dx * (origin.y - a.y) - dy * (origin.x - a.x)) / -denom;
  if (t1 < EPSILON) return null;

  return {
    point: {
      x: origin.x + ray.x * t1,
      y: origin.y + ray.y * t1,
    },
    dist: t1,
  };
}

/**
 * Clip a visibility polygon to a cone sector.
 * The cone is defined by outerAngle (total arc in degrees) and rotation (center direction in degrees).
 * OBR rotation: 0 = up/north, clockwise positive. We convert to math angles internally.
 */
function clipToCone(
  polygon: Ring,
  origin: Vector2,
  radius: number,
  outerAngleDeg: number,
  rotationDeg: number
): Ring {
  // Convert OBR rotation to math angle (OBR: 0=up, CW positive → math: 0=right, CCW positive)
  // OBR 0° = up = math -90° (or 270°)
  const centerAngle = ((rotationDeg - 90) * Math.PI) / 180;
  const halfAngle = ((outerAngleDeg / 2) * Math.PI) / 180;
  const startAngle = centerAngle - halfAngle;
  const endAngle = centerAngle + halfAngle;

  // Build the cone as a polygon: origin → arc points → origin
  const conePoints: Vector2[] = [origin];
  const arcSteps = Math.max(16, Math.ceil(outerAngleDeg / 5));
  const angleStep = (endAngle - startAngle) / arcSteps;

  for (let i = 0; i <= arcSteps; i++) {
    const a = startAngle + i * angleStep;
    conePoints.push({
      x: origin.x + Math.cos(a) * radius,
      y: origin.y + Math.sin(a) * radius,
    });
  }

  // Simple clipping: keep only polygon points inside the cone, and add cone boundary intersections
  // For a proper implementation we'd use polygon intersection, but the cone shape makes
  // a simpler approach viable: filter points by angle and add arc boundary points
  const result: Vector2[] = [];

  // Add origin as starting point
  result.push(origin);

  // Add arc start boundary at radius
  result.push({
    x: origin.x + Math.cos(startAngle) * radius,
    y: origin.y + Math.sin(startAngle) * radius,
  });

  // Filter visibility polygon points that fall within the cone's angular range
  const inCone: Vector2[] = [];
  for (const p of polygon) {
    const angle = Math.atan2(p.y - origin.y, p.x - origin.x);
    if (isAngleInRange(angle, startAngle, endAngle)) {
      inCone.push(p);
    }
  }

  // Sort cone-interior points by angle
  inCone.sort((a, b) => {
    const aa = Math.atan2(a.y - origin.y, a.x - origin.x);
    const ba = Math.atan2(b.y - origin.y, b.x - origin.x);
    return normalizeAngle(aa - startAngle) - normalizeAngle(ba - startAngle);
  });

  result.push(...inCone);

  // Add arc end boundary
  result.push({
    x: origin.x + Math.cos(endAngle) * radius,
    y: origin.y + Math.sin(endAngle) * radius,
  });

  return result;
}

/** Check if an angle falls within [start, end], handling wraparound */
function isAngleInRange(
  angle: number,
  start: number,
  end: number
): boolean {
  const normalized = normalizeAngle(angle - start);
  const range = normalizeAngle(end - start);
  return normalized <= range;
}

/** Normalize an angle to [0, 2π) */
function normalizeAngle(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}
