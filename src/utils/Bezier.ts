import * as THREE from 'three';

/**
 * Evaluate a cubic Bezier curve at parameter t ∈ [0, 1].
 * p0/p3 are endpoints, p1/p2 are control points.
 */
export function cubicBezier(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    t: number
): THREE.Vector3 {
    const mt = 1 - t;
    return new THREE.Vector3(
        mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
        mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
        mt * mt * mt * p0.z + 3 * mt * mt * t * p1.z + 3 * mt * t * t * p2.z + t * t * t * p3.z,
    );
}

/**
 * Sample a cubic Bezier curve into `divisions + 1` points.
 * divisions=0 returns just the two endpoints (straight line).
 */
export function sampleCubicBezier(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    divisions: number
): THREE.Vector3[] {
    const steps = Math.max(1, divisions + 1);
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
        points.push(cubicBezier(p0, p1, p2, p3, i / steps));
    }
    return points;
}
