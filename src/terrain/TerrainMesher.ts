import * as THREE from 'three';
import * as polygonClipping from 'polygon-clipping';
import SweepContext from 'poly2tri/src/sweepcontext.js';
import type { OccupiedTriangle } from '../elements/WorldElement';

type Point2 = [number, number];
type Ring = Point2[];
type MultiPolygon = Point2[][][];

interface PolygonRegion {
    contour: Ring;
    holes: Ring[];
}

interface Segment2 {
    a: Point2;
    b: Point2;
}

interface HeightSegment extends Segment2 {
    heightA: number;
    heightB: number;
    maxSlope: number;
}

interface SamplingTier {
    innerRadius: number;
    outerRadius: number;
    spacing: number;
}

interface SteinerCandidate {
    point: Point2;
    spacing: number;
    tier: number;
    distance: number;
}

interface TopologyCache {
    signature: string;
    triangles: [Point2, Point2, Point2][];
    regions: PolygonRegion[];
    roadSegments: Segment2[];
    activeCutPointKeys: Set<string>;
}

export interface TerrainMesherSettings {
    meshDetail: number;
    triangleLimit: number;
    smoothingEnabled: boolean;
    smoothingRadius: number;
    maxSlopeDegrees: number;
}

// A point that forces the terrain to a specific height, blending outward over `radius`.
// Used by both single terrain cut points and points sampled along a terrain cut spline.
export interface TerrainCutPointInput {
    position: THREE.Vector3;
    radius: number;
    // Optional local slope override. Rivers use this to turn their Bank Slope
    // property into a real geometric bank angle instead of relying on the
    // terrain-wide maximum slope setting.
    maxSlopeDegrees?: number;
}

export interface TerrainMesherInput {
    center: THREE.Vector3;
    width: number;
    length: number;
    cutAreas: OccupiedTriangle[];
    cutPoints: TerrainCutPointInput[];
    settings: TerrainMesherSettings;
}

export default class TerrainMesher {
    private static readonly SNAP = 1e5;
    private static readonly EPSILON = 1e-7;
    private topologyCache: TopologyCache | null = null;

    public build(input: TerrainMesherInput): OccupiedTriangle[] {
        const signature = this.getTopologySignature(input);
        let topology = this.topologyCache;

        if (!topology || topology.signature !== signature) {
            try {
                topology = this.buildTopology(input, signature);
                this.topologyCache = topology;
            } catch (error) {
                console.warn('Terrain remesh failed; rebuilding the current footprint with the fallback triangulator.', error);
                try {
                    topology = this.buildFallbackTopology(input, signature);
                    if (topology.regions.length > 0 && topology.triangles.length === 0) {
                        throw new Error('Fallback triangulator returned an empty terrain mesh.');
                    }
                } catch (fallbackError) {
                    console.warn('Terrain footprint fallback failed; using a sealed uncut surface.', fallbackError);
                    topology = this.buildSolidFallbackTopology(input, signature);
                }
                this.topologyCache = topology;
            }
        }

        if (!topology) return [];

        return this.applyHeights(topology, input);
    }

    public invalidate(): void {
        this.topologyCache = null;
    }

    private buildTopology(input: TerrainMesherInput, signature: string): TopologyCache {
        const regions = this.buildFreeRegions(input);
        if (regions.length === 0) {
            return { signature, triangles: [], regions: [], roadSegments: [], activeCutPointKeys: new Set() };
        }

        const roadBoundarySegments = this.collectRoadSegments(regions, input);
        const roadSegments = this.splitRoadSegmentsAtCutVertices(roadBoundarySegments, input.cutAreas);
        const activeCutPoints = input.cutPoints.filter((point) => (
            this.findContainingRegion([point.position.x, point.position.z], regions) !== null
            && !this.isInsideCutArea([point.position.x, point.position.z], input.cutAreas)
        ));
        const activeCutPointKeys = new Set(activeCutPoints.map((point) => this.pointKey([point.position.x, point.position.z])));
        const mandatoryEstimate = regions.reduce((sum, region) => (
            sum + region.contour.length + region.holes.reduce((holeSum, hole) => holeSum + hole.length, 0)
        ), 0) + activeCutPoints.length + Math.max(0, roadSegments.length - roadBoundarySegments.length);
        const maxSteiner = Math.max(0, Math.floor((input.settings.triangleLimit - mandatoryEstimate) / 2));
        const steiner = this.generateSteinerPoints(input, regions, roadSegments, activeCutPoints, maxSteiner);

        let triangles = this.insertRoadBoundaryKnots(
            this.triangulateRegions(regions, steiner),
            roadBoundarySegments,
            input.cutAreas,
        );
        for (let pass = 0; pass < 3; pass++) {
            const remaining = Math.max(0, Math.floor((input.settings.triangleLimit - triangles.length) / 2));
            if (remaining === 0 || roadSegments.length + activeCutPoints.length === 0) break;
            const candidates = this.collectRefinementPoints(
                triangles,
                regions,
                roadSegments,
                activeCutPoints,
                input.settings,
                remaining,
                steiner,
            );
            if (candidates.length === 0) break;
            steiner.push(...candidates);
            triangles = this.insertRoadBoundaryKnots(
                this.triangulateRegions(regions, steiner),
                roadBoundarySegments,
                input.cutAreas,
            );
        }

        if (triangles.length > input.settings.triangleLimit) {
            const essential = activeCutPoints.map((point) => [point.position.x, point.position.z] as Point2);
            triangles = this.insertRoadBoundaryKnots(
                this.triangulateRegions(regions, essential),
                roadBoundarySegments,
                input.cutAreas,
            );
        }

        this.assertRoadBoundariesAreSealed(triangles, roadSegments);

        return { signature, triangles, regions, roadSegments, activeCutPointKeys };
    }

    private buildFallbackTopology(input: TerrainMesherInput, signature: string): TopologyCache {
        const regions = this.buildFreeRegions(input);
        const triangles: [Point2, Point2, Point2][] = [];
        for (const region of regions) {
            const contour = region.contour.map(([x, y]) => new THREE.Vector2(x, y));
            const holes = region.holes.map((hole) => hole.map(([x, y]) => new THREE.Vector2(x, y)));
            const indices = THREE.ShapeUtils.triangulateShape(contour, holes);
            const points = [...region.contour, ...region.holes.flat()];
            for (const [a, b, c] of indices) triangles.push([points[a], points[b], points[c]]);
        }
        const roadBoundarySegments = this.collectRoadSegments(regions, input);
        const roadSegments = this.splitRoadSegmentsAtCutVertices(roadBoundarySegments, input.cutAreas);
        const trianglesWithBoundaryKnots = this.insertRoadBoundaryKnots(triangles, roadBoundarySegments, input.cutAreas);
        this.assertRoadBoundariesAreSealed(trianglesWithBoundaryKnots, roadSegments);
        const activeCutPointKeys = new Set(input.cutPoints
            .filter((point) => this.findContainingRegion([point.position.x, point.position.z], regions) !== null)
            .map((point) => this.pointKey([point.position.x, point.position.z])));
        return { signature, triangles: trianglesWithBoundaryKnots, regions, roadSegments, activeCutPointKeys };
    }

    private assertRoadBoundariesAreSealed(
        triangles: [Point2, Point2, Point2][],
        roadSegments: Segment2[],
    ): void {
        const meshEdges = new Set<string>();
        for (const triangle of triangles) {
            meshEdges.add(this.edgeKey(triangle[0], triangle[1]));
            meshEdges.add(this.edgeKey(triangle[1], triangle[2]));
            meshEdges.add(this.edgeKey(triangle[2], triangle[0]));
        }
        const missing = roadSegments.find((segment) => !meshEdges.has(this.edgeKey(segment.a, segment.b)));
        if (missing) {
            throw new Error(`Terrain mesh does not contain cutter boundary ${this.edgeKey(missing.a, missing.b)}.`);
        }
    }

    private buildSolidFallbackTopology(input: TerrainMesherInput, signature: string): TopologyCache {
        const minX = input.center.x - input.width / 2;
        const maxX = input.center.x + input.width / 2;
        const minZ = input.center.z - input.length / 2;
        const maxZ = input.center.z + input.length / 2;
        const contour: Ring = [
            [minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ],
        ].map((point) => this.snapPoint(point as Point2));
        return {
            signature,
            triangles: [
                [contour[0], contour[1], contour[2]],
                [contour[0], contour[2], contour[3]],
            ],
            regions: [{ contour, holes: [] }],
            roadSegments: [],
            activeCutPointKeys: new Set(),
        };
    }

    private buildFreeRegions(input: TerrainMesherInput): PolygonRegion[] {
        const minX = input.center.x - input.width / 2;
        const maxX = input.center.x + input.width / 2;
        const minZ = input.center.z - input.length / 2;
        const maxZ = input.center.z + input.length / 2;
        const surface: MultiPolygon = [[[
            [minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ], [minX, minZ],
        ]]];

        const cutterPolygons: MultiPolygon[] = [];
        for (const tri of input.cutAreas) {
            const a = this.snapPoint([tri.a.x, tri.a.z]);
            const b = this.snapPoint([tri.b.x, tri.b.z]);
            const c = this.snapPoint([tri.c.x, tri.c.z]);
            if (Math.abs(this.signedArea([a, b, c])) <= TerrainMesher.EPSILON) continue;
            cutterPolygons.push([[[a, b, c, a]]]);
        }

        let free: MultiPolygon = surface;
        if (cutterPolygons.length > 0) {
            const cutters = (polygonClipping as any).union(...cutterPolygons) as MultiPolygon | null;
            if (cutters?.length) {
                free = ((polygonClipping as any).difference(surface, cutters) as MultiPolygon | null) ?? [];
            }
        }

        const regions: PolygonRegion[] = [];
        for (const polygon of free) {
            if (polygon.length === 0) continue;
            const contour = this.sanitizeRing(polygon[0], false);
            if (contour.length < 3) continue;
            const holes = polygon.slice(1)
                .map((ring) => this.sanitizeRing(ring, true))
                .filter((ring) => ring.length >= 3);
            regions.push({ contour, holes });
        }
        return regions;
    }

    private sanitizeRing(source: Point2[], clockwise: boolean): Ring {
        const ring: Ring = [];
        for (const raw of source) {
            const point = this.snapPoint(raw);
            if (ring.length === 0 || this.pointKey(ring[ring.length - 1]) !== this.pointKey(point)) {
                ring.push(point);
            }
        }
        if (ring.length > 1 && this.pointKey(ring[0]) === this.pointKey(ring[ring.length - 1])) ring.pop();

        let changed = true;
        while (changed && ring.length > 3) {
            changed = false;
            for (let i = 0; i < ring.length; i++) {
                const prev = ring[(i - 1 + ring.length) % ring.length];
                const curr = ring[i];
                const next = ring[(i + 1) % ring.length];
                if (Math.abs(this.signedArea([prev, curr, next])) <= TerrainMesher.EPSILON) {
                    ring.splice(i, 1);
                    changed = true;
                    break;
                }
            }
        }

        const isClockwise = this.signedArea(ring) < 0;
        if (isClockwise !== clockwise) ring.reverse();
        return ring;
    }

    private collectRoadSegments(regions: PolygonRegion[], input: TerrainMesherInput): Segment2[] {
        const result: Segment2[] = [];
        const seen = new Set<string>();
        const minX = input.center.x - input.width / 2;
        const maxX = input.center.x + input.width / 2;
        const minZ = input.center.z - input.length / 2;
        const maxZ = input.center.z + input.length / 2;
        for (const region of regions) {
            const rings = [region.contour, ...region.holes];
            for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
                const ring = rings[ringIndex];
                for (let i = 0; i < ring.length; i++) {
                    const a = ring[i];
                    const b = ring[(i + 1) % ring.length];
                    const isHoleBoundary = ringIndex > 0;
                    if (!isHoleBoundary && this.isTerrainOuterBoundarySegment(a, b, minX, maxX, minZ, maxZ)) continue;
                    const key = this.edgeKey(a, b);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    result.push({ a, b });
                }
            }
        }
        return result;
    }

    private splitRoadSegmentsAtCutVertices(
        segments: Segment2[],
        cutAreas: OccupiedTriangle[],
    ): Segment2[] {
        const result: Segment2[] = [];
        for (const segment of segments) {
            const knots = this.getRoadBoundaryKnots(segment, cutAreas);
            for (let i = 0; i < knots.length - 1; i++) {
                if (this.distance(knots[i], knots[i + 1]) <= TerrainMesher.EPSILON) continue;
                result.push({ a: knots[i], b: knots[i + 1] });
            }
        }
        return result;
    }

    private insertRoadBoundaryKnots(
        triangles: [Point2, Point2, Point2][],
        boundarySegments: Segment2[],
        cutAreas: OccupiedTriangle[],
    ): [Point2, Point2, Point2][] {
        const result = triangles.slice();
        for (const segment of boundarySegments) {
            const knots = this.getRoadBoundaryKnots(segment, cutAreas);
            if (knots.length <= 2) continue;

            let triangleIndex = -1;
            let edgeIndex = -1;
            const segmentKey = this.edgeKey(segment.a, segment.b);
            for (let i = 0; i < result.length && triangleIndex < 0; i++) {
                for (let edge = 0; edge < 3; edge++) {
                    if (this.edgeKey(result[i][edge], result[i][(edge + 1) % 3]) === segmentKey) {
                        triangleIndex = i;
                        edgeIndex = edge;
                        break;
                    }
                }
            }
            if (triangleIndex < 0 || edgeIndex < 0) continue;

            const triangle = result[triangleIndex];
            const start = triangle[edgeIndex];
            const third = triangle[(edgeIndex + 2) % 3];
            const ordered = this.pointKey(start) === this.pointKey(segment.a) ? knots : knots.slice().reverse();
            const replacements: [Point2, Point2, Point2][] = [];
            for (let i = 0; i < ordered.length - 1; i++) {
                const splitTriangle: [Point2, Point2, Point2] = [ordered[i], ordered[i + 1], third];
                if (Math.abs(this.signedArea(splitTriangle)) > TerrainMesher.EPSILON) replacements.push(splitTriangle);
            }
            result.splice(triangleIndex, 1, ...replacements);
        }
        return result;
    }

    private getRoadBoundaryKnots(segment: Segment2, cutAreas: OccupiedTriangle[]): Point2[] {
        const candidates = new Map<string, { point: Point2; t: number }>();
        const add = (point: Point2): void => {
            const snapped = this.snapPoint(point);
            const projection = this.projectToSegment(snapped, segment.a, segment.b);
            if (projection.distance > 5 / TerrainMesher.SNAP) return;
            if (projection.t < -TerrainMesher.EPSILON || projection.t > 1 + TerrainMesher.EPSILON) return;
            candidates.set(this.pointKey(snapped), { point: snapped, t: projection.t });
        };
        add(segment.a);
        add(segment.b);
        for (const triangle of cutAreas) {
            add([triangle.a.x, triangle.a.z]);
            add([triangle.b.x, triangle.b.z]);
            add([triangle.c.x, triangle.c.z]);
        }
        return [...candidates.values()]
            .sort((a, b) => a.t - b.t || this.pointKey(a.point).localeCompare(this.pointKey(b.point)))
            .map((candidate) => candidate.point);
    }

    private isTerrainOuterBoundarySegment(
        a: Point2,
        b: Point2,
        minX: number,
        maxX: number,
        minZ: number,
        maxZ: number,
    ): boolean {
        const epsilon = 2 / TerrainMesher.SNAP;
        const onSameBoundary = (valueA: number, valueB: number, boundary: number): boolean => (
            Math.abs(valueA - boundary) <= epsilon && Math.abs(valueB - boundary) <= epsilon
        );
        return onSameBoundary(a[0], b[0], minX)
            || onSameBoundary(a[0], b[0], maxX)
            || onSameBoundary(a[1], b[1], minZ)
            || onSameBoundary(a[1], b[1], maxZ);
    }

    private generateSteinerPoints(
        input: TerrainMesherInput,
        regions: PolygonRegion[],
        roadSegments: Segment2[],
        cutPoints: TerrainCutPointInput[],
        limit: number,
    ): Point2[] {
        const result: Point2[] = [];
        const occupied = this.collectBoundaryKeys(regions);
        const detail = Math.max(0.05, input.settings.meshDetail);
        const addExactPoint = (point: Point2): void => {
            if (result.length >= limit) return;
            const snapped = this.snapPoint(point);
            const key = this.pointKey(snapped);
            if (occupied.has(key) || !this.isStrictlyInsideRegions(snapped, regions)) return;
            occupied.add(key);
            result.push(snapped);
        };

        for (const point of cutPoints) {
            addExactPoint([point.position.x, point.position.z]);
        }

        if (result.length >= limit || roadSegments.length + cutPoints.length === 0) return result;

        const terrainDiagonal = Math.hypot(input.width, input.length);
        const baseRadius = Math.max(detail * 2, input.settings.smoothingRadius);
        const tierCount = input.settings.smoothingEnabled ? 4 : 2;
        const tiers: SamplingTier[] = [];
        for (let tier = 0; tier < tierCount; tier++) {
            const innerRadius = tier === 0 ? 0 : baseRadius * 2 ** (tier - 1);
            const outerRadius = Math.min(terrainDiagonal, baseRadius * 2 ** tier);
            if (outerRadius <= innerRadius + TerrainMesher.EPSILON) break;
            tiers.push({ innerRadius, outerRadius, spacing: detail * 2 ** tier });
        }

        const candidates = new Map<string, SteinerCandidate>();
        const scanLimit = Math.max(2000, limit * 24);
        let scanned = 0;
        for (let tierIndex = 0; tierIndex < tiers.length && scanned < scanLimit; tierIndex++) {
            const tier = tiers[tierIndex];
            const visited = new Set<string>();
            const visitBounds = (minX: number, maxX: number, minZ: number, maxZ: number): void => {
                if (scanned >= scanLimit) return;
                this.forEachTriangularLatticePoint(minX, maxX, minZ, maxZ, tier.spacing, (point) => {
                    if (scanned >= scanLimit) return false;
                    const key = this.pointKey(point);
                    if (visited.has(key)) return true;
                    visited.add(key);
                    scanned++;
                    if (occupied.has(key)) return true;

                    const region = this.findContainingRegion(point, regions);
                    if (!region) return true;
                    const boundaryClearance = Math.min(detail * 0.25, tier.spacing * 0.2);
                    if (this.getDistanceToRegionBoundary(point, region) < boundaryClearance) return true;

                    const distance = this.getNearestInfluenceDistance(point, roadSegments, cutPoints);
                    if (distance <= tier.innerRadius + TerrainMesher.EPSILON
                        || distance > tier.outerRadius + TerrainMesher.EPSILON) return true;

                    const current = candidates.get(key);
                    if (!current || tierIndex < current.tier) {
                        candidates.set(key, { point: this.snapPoint(point), spacing: tier.spacing, tier: tierIndex, distance });
                    }
                    return true;
                });
            };

            for (const segment of roadSegments) {
                visitBounds(
                    Math.min(segment.a[0], segment.b[0]) - tier.outerRadius,
                    Math.max(segment.a[0], segment.b[0]) + tier.outerRadius,
                    Math.min(segment.a[1], segment.b[1]) - tier.outerRadius,
                    Math.max(segment.a[1], segment.b[1]) + tier.outerRadius,
                );
                if (scanned >= scanLimit) break;
            }
            if (scanned < scanLimit) {
                for (const point of cutPoints) {
                    visitBounds(
                        point.position.x - tier.outerRadius, point.position.x + tier.outerRadius,
                        point.position.z - tier.outerRadius, point.position.z + tier.outerRadius,
                    );
                    if (scanned >= scanLimit) break;
                }
            }
        }

        const ordered = [...candidates.values()].sort((a, b) => (
            a.tier - b.tier
            || a.distance - b.distance
            || this.pointKey(a.point).localeCompare(this.pointKey(b.point))
        ));
        for (const candidate of ordered) {
            if (result.length >= limit) break;
            const minimumSeparation = candidate.spacing * 0.55;
            if (result.some((point) => this.distance(point, candidate.point) < minimumSeparation)) continue;
            const key = this.pointKey(candidate.point);
            if (occupied.has(key)) continue;
            occupied.add(key);
            result.push(candidate.point);
        }
        return result;
    }

    private collectRefinementPoints(
        triangles: [Point2, Point2, Point2][],
        regions: PolygonRegion[],
        roadSegments: Segment2[],
        cutPoints: TerrainCutPointInput[],
        settings: TerrainMesherSettings,
        limit: number,
        existing: Point2[],
    ): Point2[] {
        const occupied = this.collectBoundaryKeys(regions);
        for (const point of existing) occupied.add(this.pointKey(point));
        const scored: SteinerCandidate[] = [];
        const detail = Math.max(0.05, settings.meshDetail);
        const baseRadius = Math.max(detail * 2, settings.smoothingRadius);
        const activeRadius = baseRadius * (settings.smoothingEnabled ? 8 : 2);

        for (const tri of triangles) {
            const centroid: Point2 = [
                (tri[0][0] + tri[1][0] + tri[2][0]) / 3,
                (tri[0][1] + tri[1][1] + tri[2][1]) / 3,
            ];
            const influenceDistance = this.getNearestInfluenceDistance(centroid, roadSegments, cutPoints);
            if (influenceDistance > activeRadius) continue;
            const desired = this.getAdaptiveSpacing(influenceDistance, detail, baseRadius);
            const edges = [
                this.distance(tri[0], tri[1]),
                this.distance(tri[1], tri[2]),
                this.distance(tri[2], tri[0]),
            ];
            const longest = Math.max(...edges);
            const minAngle = this.getMinimumAngle(edges[0], edges[1], edges[2]);
            const tooLong = longest > desired * 2.4;
            const tooThin = minAngle < 11 && longest > desired * 1.35;
            if (!tooLong && !tooThin) continue;

            const circumcenter = this.getCircumcenter(tri);
            const candidate = circumcenter
                && this.isPointInTriangle(circumcenter, tri)
                && this.isStrictlyInsideRegions(circumcenter, regions)
                ? circumcenter
                : centroid;
            const region = this.findContainingRegion(candidate, regions);
            if (!region || this.getDistanceToRegionBoundary(candidate, region) < desired * 0.35) continue;
            const snapped = this.snapPoint(candidate);
            if (occupied.has(this.pointKey(snapped))) continue;
            if (existing.some((point) => this.distance(point, snapped) < desired * 0.6)) continue;
            const score = Math.max(longest / desired, 11 / Math.max(minAngle, 0.01));
            scored.push({ point: snapped, spacing: desired, tier: 0, distance: -score });
        }

        scored.sort((a, b) => a.distance - b.distance || this.pointKey(a.point).localeCompare(this.pointKey(b.point)));
        const result: Point2[] = [];
        const passLimit = Math.min(limit, Math.max(4, Math.ceil(triangles.length * 0.08)));
        for (const item of scored) {
            const key = this.pointKey(item.point);
            if (occupied.has(key)) continue;
            if (result.some((point) => this.distance(point, item.point) < item.spacing * 0.6)) continue;
            occupied.add(key);
            result.push(item.point);
            if (result.length >= passLimit) break;
        }
        return result;
    }

    private triangulateRegions(regions: PolygonRegion[], steiner: Point2[]): [Point2, Point2, Point2][] {
        const result: [Point2, Point2, Point2][] = [];
        for (const region of regions) {
            const context = new SweepContext(
                region.contour.map(([x, y]) => ({ x, y })),
                { cloneArrays: true },
            );
            for (const hole of region.holes) {
                context.addHole(hole.map(([x, y]) => ({ x, y })));
            }
            const regionPoints = steiner.filter((point) => this.isStrictlyInsideRegion(point, region));
            if (regionPoints.length > 0) {
                context.addPoints(regionPoints.map(([x, y]) => ({ x, y })));
            }
            context.triangulate();
            for (const triangle of context.getTriangles()) {
                const points = triangle.getPoints().map((point) => [point.x, point.y] as Point2) as [Point2, Point2, Point2];
                if (Math.abs(this.signedArea(points)) <= TerrainMesher.EPSILON) continue;
                result.push(points);
            }
        }
        return result;
    }

    private applyHeights(topology: TopologyCache, input: TerrainMesherInput): OccupiedTriangle[] {
        const cutPointMap = new Map<string, TerrainCutPointInput>();
        for (const point of input.cutPoints) {
            const key = this.pointKey([point.position.x, point.position.z]);
            if (topology.activeCutPointKeys.has(key)) cutPointMap.set(key, point);
        }

        const maxSlopeRadians = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(input.settings.maxSlopeDegrees, 1, 89));
        const maxSlope = Math.max(0.01, Math.tan(maxSlopeRadians));
        const roadHeightSegments: HeightSegment[] = [];
        for (const segment of topology.roadSegments) {
            const midpoint: Point2 = [(segment.a[0] + segment.b[0]) / 2, (segment.a[1] + segment.b[1]) / 2];
            const fallback = this.sampleCutBoundary(midpoint, input.cutAreas);
            const sampleA = this.sampleCutBoundary(segment.a, input.cutAreas) ?? fallback;
            const sampleB = this.sampleCutBoundary(segment.b, input.cutAreas) ?? fallback;
            if (!sampleA || !sampleB) continue;
            // A boundary triangle can override the terrain's global max slope (e.g. a river
            // wanting a steep bank instead of the wide, gentle blend a road would want).
            const slopeDegrees = sampleA.slopeDegrees ?? sampleB.slopeDegrees ?? input.settings.maxSlopeDegrees;
            const segmentMaxSlope = Math.max(0.01, Math.tan(THREE.MathUtils.degToRad(THREE.MathUtils.clamp(slopeDegrees, 1, 89))));
            roadHeightSegments.push({ ...segment, heightA: sampleA.height, heightB: sampleB.height, maxSlope: segmentMaxSlope });
        }
        const heightCache = new Map<string, number>();
        const heightOf = (point: Point2): number => {
            const key = this.pointKey(point);
            const cached = heightCache.get(key);
            if (cached !== undefined) return cached;

            const exactCutPoint = cutPointMap.get(key);
            if (exactCutPoint) {
                heightCache.set(key, exactCutPoint.position.y);
                return exactCutPoint.position.y;
            }

            const road = this.getNearestRoadConstraint(point, roadHeightSegments);
            if (road && road.distance <= TerrainMesher.EPSILON * 20) {
                heightCache.set(key, road.height);
                return road.height;
            }

            if (!input.settings.smoothingEnabled) {
                heightCache.set(key, input.center.y);
                return input.center.y;
            }

            let weightedDelta = 0;
            let weightSum = 0;
            let localSlopeHeight: number | null = null;
            if (road) {
                const width = Math.max(input.settings.smoothingRadius, 1.5 * Math.abs(road.height - input.center.y) / road.maxSlope);
                const weight = this.smoothInfluence(road.distance, width);
                weightedDelta += (road.height - input.center.y) * weight;
                weightSum += weight;
            }
            for (const cutPoint of cutPointMap.values()) {
                const distance = Math.hypot(point[0] - cutPoint.position.x, point[1] - cutPoint.position.z);
                if (cutPoint.maxSlopeDegrees !== undefined) {
                    if (distance > cutPoint.radius) continue;
                    const pointSlope = Math.tan(THREE.MathUtils.degToRad(
                        THREE.MathUtils.clamp(cutPoint.maxSlopeDegrees, 1, 89),
                    ));
                    const candidate = cutPoint.position.y < input.center.y
                        ? Math.min(input.center.y, cutPoint.position.y + distance * pointSlope)
                        : Math.max(input.center.y, cutPoint.position.y - distance * pointSlope);
                    if (localSlopeHeight === null
                        || Math.abs(candidate - input.center.y) > Math.abs(localSlopeHeight - input.center.y)) {
                        localSlopeHeight = candidate;
                    }
                    continue;
                }
                // A cut point's own radius sets how far its height modification reaches,
                // still respecting the max-slope constraint so steep drops stay walkable.
                const slopeRun = Math.abs(cutPoint.position.y - input.center.y) / Math.max(maxSlope, 1e-6);
                const width = Math.max(cutPoint.radius, 1.5 * slopeRun);
                const weight = this.smoothInfluence(distance, width);
                weightedDelta += (cutPoint.position.y - input.center.y) * weight;
                weightSum += weight;
            }
            let height = input.center.y + weightedDelta / Math.max(1, weightSum);
            if (localSlopeHeight !== null) {
                height = localSlopeHeight < input.center.y
                    ? Math.min(height, localSlopeHeight)
                    : Math.max(height, localSlopeHeight);
            }
            heightCache.set(key, height);
            return height;
        };

        const result: OccupiedTriangle[] = [];
        for (const tri of topology.triangles) {
            const a = new THREE.Vector3(tri[0][0], heightOf(tri[0]), tri[0][1]);
            const b = new THREE.Vector3(tri[1][0], heightOf(tri[1]), tri[1][1]);
            const c = new THREE.Vector3(tri[2][0], heightOf(tri[2]), tri[2][1]);
            if (this.signedArea(tri) > 0) result.push({ a, b: c, c: b });
            else result.push({ a, b, c });
        }
        return result;
    }

    private getNearestRoadConstraint(point: Point2, segments: HeightSegment[]): { distance: number; height: number; maxSlope: number } | null {
        let best: { distance: number; height: number; maxSlope: number } | null = null;
        for (const segment of segments) {
            const projection = this.projectToSegment(point, segment.a, segment.b);
            const height = segment.heightA + (segment.heightB - segment.heightA) * projection.t;
            if (!best || projection.distance < best.distance) best = { distance: projection.distance, height, maxSlope: segment.maxSlope };
        }
        return best;
    }

    private sampleCutContainedBoundary(point: Point2, triangles: OccupiedTriangle[]): { height: number; slopeDegrees?: number } | null {
        let best: { height: number; slopeDegrees?: number } | null = null;
        for (const tri of triangles) {
            const barycentric = this.getBarycentric(point, tri);
            if (!barycentric) continue;
            const height = tri.a.y * barycentric.u + tri.b.y * barycentric.v + tri.c.y * barycentric.w;
            if (!best || height > best.height) best = { height, slopeDegrees: tri.bankSlopeDegrees };
        }
        return best;
    }

    private sampleCutBoundary(point: Point2, triangles: OccupiedTriangle[]): { height: number; slopeDegrees?: number } | null {
        const contained = this.sampleCutContainedBoundary(point, triangles);
        if (contained !== null) return contained;

        let bestDistance = Number.POSITIVE_INFINITY;
        let bestHeight: number | null = null;
        let bestSlope: number | undefined;
        for (const tri of triangles) {
            const vertices = [tri.a, tri.b, tri.c];
            for (let i = 0; i < 3; i++) {
                const a = vertices[i];
                const b = vertices[(i + 1) % 3];
                const projection = this.projectToSegment(point, [a.x, a.z], [b.x, b.z]);
                const height = a.y + (b.y - a.y) * projection.t;
                if (projection.distance < bestDistance - TerrainMesher.EPSILON) {
                    bestDistance = projection.distance;
                    bestHeight = height;
                    bestSlope = tri.bankSlopeDegrees;
                } else if (Math.abs(projection.distance - bestDistance) <= TerrainMesher.EPSILON) {
                    if (bestHeight === null || height > bestHeight) {
                        bestHeight = height;
                        bestSlope = tri.bankSlopeDegrees;
                    }
                }
            }
        }
        return bestHeight === null ? null : { height: bestHeight, slopeDegrees: bestSlope };
    }

    private getBarycentric(point: Point2, tri: OccupiedTriangle): { u: number; v: number; w: number } | null {
        const denominator = ((tri.b.z - tri.c.z) * (tri.a.x - tri.c.x))
            + ((tri.c.x - tri.b.x) * (tri.a.z - tri.c.z));
        if (Math.abs(denominator) <= TerrainMesher.EPSILON) return null;
        const u = (((tri.b.z - tri.c.z) * (point[0] - tri.c.x))
            + ((tri.c.x - tri.b.x) * (point[1] - tri.c.z))) / denominator;
        const v = (((tri.c.z - tri.a.z) * (point[0] - tri.c.x))
            + ((tri.a.x - tri.c.x) * (point[1] - tri.c.z))) / denominator;
        const w = 1 - u - v;
        const epsilon = 2e-5;
        return u >= -epsilon && v >= -epsilon && w >= -epsilon ? { u, v, w } : null;
    }

    private isInsideCutArea(point: Point2, triangles: OccupiedTriangle[]): boolean {
        return triangles.some((tri) => this.getBarycentric(point, tri) !== null);
    }

    private smoothInfluence(distance: number, width: number): number {
        if (width <= TerrainMesher.EPSILON || distance >= width) return 0;
        const t = THREE.MathUtils.clamp(distance / width, 0, 1);
        const smoothStep = t * t * (3 - 2 * t);
        return 1 - smoothStep;
    }

    private getTopologySignature(input: TerrainMesherInput): string {
        const cutterKeys = input.cutAreas.map((tri) => [tri.a, tri.b, tri.c]
            .map((point) => this.pointKey([point.x, point.z])).sort().join(';')).sort();
        const pointKeys = input.cutPoints.map((point) => this.pointKey([point.position.x, point.position.z])).sort();
        return [
            this.pointKey([input.center.x, input.center.z]),
            this.snap(input.width), this.snap(input.length),
            this.snap(input.settings.meshDetail), Math.round(input.settings.triangleLimit),
            input.settings.smoothingEnabled ? 1 : 0,
            this.snap(input.settings.smoothingRadius),
            cutterKeys.join('|'), pointKeys.join('|'),
        ].join('#');
    }

    private forEachTriangularLatticePoint(
        minX: number,
        maxX: number,
        minZ: number,
        maxZ: number,
        spacing: number,
        visit: (point: Point2) => boolean,
    ): void {
        const rowHeight = spacing * Math.sqrt(3) / 2;
        const firstRow = Math.floor(minZ / rowHeight) - 1;
        const lastRow = Math.ceil(maxZ / rowHeight) + 1;
        for (let row = firstRow; row <= lastRow; row++) {
            const z = row * rowHeight;
            if (z < minZ - TerrainMesher.EPSILON || z > maxZ + TerrainMesher.EPSILON) continue;
            const parity = ((row % 2) + 2) % 2;
            const offset = parity * spacing * 0.5;
            const firstColumn = Math.floor((minX - offset) / spacing) - 1;
            const lastColumn = Math.ceil((maxX - offset) / spacing) + 1;
            for (let column = firstColumn; column <= lastColumn; column++) {
                const x = column * spacing + offset;
                if (x < minX - TerrainMesher.EPSILON || x > maxX + TerrainMesher.EPSILON) continue;
                if (!visit(this.snapPoint([x, z]))) return;
            }
        }
    }

    private getAdaptiveSpacing(distance: number, detail: number, baseRadius: number): number {
        if (distance <= baseRadius) return detail;
        const tier = THREE.MathUtils.clamp(Math.ceil(Math.log2(distance / baseRadius)), 1, 3);
        return detail * 2 ** tier;
    }

    private getCircumcenter(triangle: [Point2, Point2, Point2]): Point2 | null {
        const [a, b, c] = triangle;
        const denominator = 2 * (
            a[0] * (b[1] - c[1])
            + b[0] * (c[1] - a[1])
            + c[0] * (a[1] - b[1])
        );
        if (Math.abs(denominator) <= TerrainMesher.EPSILON) return null;
        const aLength = a[0] * a[0] + a[1] * a[1];
        const bLength = b[0] * b[0] + b[1] * b[1];
        const cLength = c[0] * c[0] + c[1] * c[1];
        return this.snapPoint([
            (aLength * (b[1] - c[1]) + bLength * (c[1] - a[1]) + cLength * (a[1] - b[1])) / denominator,
            (aLength * (c[0] - b[0]) + bLength * (a[0] - c[0]) + cLength * (b[0] - a[0])) / denominator,
        ]);
    }

    private isPointInTriangle(point: Point2, triangle: [Point2, Point2, Point2]): boolean {
        const side = (a: Point2, b: Point2): number => (
            (point[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (point[1] - b[1])
        );
        const d1 = side(triangle[0], triangle[1]);
        const d2 = side(triangle[1], triangle[2]);
        const d3 = side(triangle[2], triangle[0]);
        const hasNegative = d1 < -TerrainMesher.EPSILON || d2 < -TerrainMesher.EPSILON || d3 < -TerrainMesher.EPSILON;
        const hasPositive = d1 > TerrainMesher.EPSILON || d2 > TerrainMesher.EPSILON || d3 > TerrainMesher.EPSILON;
        return !(hasNegative && hasPositive);
    }

    private collectBoundaryKeys(regions: PolygonRegion[]): Set<string> {
        const result = new Set<string>();
        for (const region of regions) {
            for (const ring of [region.contour, ...region.holes]) {
                for (const point of ring) result.add(this.pointKey(point));
            }
        }
        return result;
    }

    private findContainingRegion(point: Point2, regions: PolygonRegion[]): PolygonRegion | null {
        return regions.find((region) => this.isInsideRegion(point, region)) ?? null;
    }

    private isInsideRegion(point: Point2, region: PolygonRegion): boolean {
        return this.pointInRing(point, region.contour)
            && !region.holes.some((hole) => this.pointInRing(point, hole));
    }

    private isStrictlyInsideRegion(point: Point2, region: PolygonRegion): boolean {
        if (!this.isInsideRegion(point, region)) return false;
        return this.getDistanceToRegionBoundary(point, region) > TerrainMesher.EPSILON * 20;
    }

    private isStrictlyInsideRegions(point: Point2, regions: PolygonRegion[]): boolean {
        return regions.some((region) => this.isStrictlyInsideRegion(point, region));
    }

    private pointInRing(point: Point2, ring: Ring): boolean {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i];
            const b = ring[j];
            const intersects = ((a[1] > point[1]) !== (b[1] > point[1]))
                && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / ((b[1] - a[1]) || 1e-12) + a[0];
            if (intersects) inside = !inside;
        }
        return inside;
    }

    private getDistanceToRegionBoundary(point: Point2, region: PolygonRegion): number {
        let best = Number.POSITIVE_INFINITY;
        for (const ring of [region.contour, ...region.holes]) {
            for (let i = 0; i < ring.length; i++) {
                best = Math.min(best, this.projectToSegment(point, ring[i], ring[(i + 1) % ring.length]).distance);
            }
        }
        return best;
    }

    private getNearestInfluenceDistance(point: Point2, roads: Segment2[], cutPoints: TerrainCutPointInput[]): number {
        let best = Number.POSITIVE_INFINITY;
        for (const segment of roads) best = Math.min(best, this.projectToSegment(point, segment.a, segment.b).distance);
        for (const cutPoint of cutPoints) best = Math.min(best, Math.hypot(point[0] - cutPoint.position.x, point[1] - cutPoint.position.z));
        return Number.isFinite(best) ? best : 0;
    }

    private projectToSegment(point: Point2, a: Point2, b: Point2): { point: Point2; distance: number; t: number } {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq <= 1e-12 ? 0 : THREE.MathUtils.clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSq, 0, 1);
        const projected: Point2 = [a[0] + dx * t, a[1] + dy * t];
        return { point: projected, distance: this.distance(point, projected), t };
    }

    private getMinimumAngle(a: number, b: number, c: number): number {
        const angle = (opposite: number, sideA: number, sideB: number): number => {
            const denominator = Math.max(1e-12, 2 * sideA * sideB);
            return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp((sideA * sideA + sideB * sideB - opposite * opposite) / denominator, -1, 1)));
        };
        return Math.min(angle(a, b, c), angle(b, c, a), angle(c, a, b));
    }

    private snapPoint(point: Point2): Point2 {
        return [this.snap(point[0]), this.snap(point[1])];
    }

    private snap(value: number): number {
        return Math.round(value * TerrainMesher.SNAP) / TerrainMesher.SNAP;
    }

    private pointKey(point: Point2): string {
        return `${this.snap(point[0])},${this.snap(point[1])}`;
    }

    private edgeKey(a: Point2, b: Point2): string {
        const ka = this.pointKey(a);
        const kb = this.pointKey(b);
        return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    }

    private signedArea(ring: Ring): number {
        let area = 0;
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            area += a[0] * b[1] - b[0] * a[1];
        }
        return area * 0.5;
    }

    private distance(a: Point2, b: Point2): number {
        return Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
}
