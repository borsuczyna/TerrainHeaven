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
    usesTerrainSlope: boolean;
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
    // 0 keeps a straight bank profile, 1 rounds its bottom and top. The bank
    // radius is expanded by the source so smoothing never exceeds maxSlopeDegrees.
    slopeSmoothing?: number;
    // Pins an extra profile vertex without creating another radial influence.
    // This gives narrow riverbanks enough topology to render smoothly.
    profileOnly?: boolean;
}

export interface TerrainPaintHeightInput {
    gridX: number;
    gridZ: number;
    height: number;
}

export interface TerrainPaintInput {
    cellSize: number;
    samples: TerrainPaintHeightInput[];
}

export interface TerrainRect {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

export interface TerrainMesherInput {
    center: THREE.Vector3;
    baseHeight?: number;
    width: number;
    length: number;
    // The surface to mesh. A group of touching terrain tiles passes every tile here and
    // gets one continuous mesh over their union, which is the only way neighbouring
    // tiles can be guaranteed to share vertices and heights. Omitted means the single
    // rectangle described by center/width/length.
    footprint?: TerrainRect[];
    cutAreas: OccupiedTriangle[];
    influenceAreas?: OccupiedTriangle[];
    cutPoints: TerrainCutPointInput[];
    paint?: TerrainPaintInput;
    settings: TerrainMesherSettings;
}

export default class TerrainMesher {
    private static readonly SNAP = 1e5;
    private static readonly BOUNDARY_EPSILON = 2 / 1e5;
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
        const sealedRoadSegments = this.splitRoadSegmentsAtCutVertices(roadBoundarySegments, input.cutAreas);
        const roadSegments = this.mergeSegments(
            sealedRoadSegments,
            this.collectInfluenceBoundarySegments(input.influenceAreas ?? input.cutAreas),
        );
        const activeCutPoints = input.cutPoints.filter((point) => (
            this.doesCutPointInfluenceRegions(point, regions, point.radius)
            && !this.isInsideCutArea([point.position.x, point.position.z], input.cutAreas)
        ));
        const activePaintPoints = this.getActivePaintPoints(input, regions);
        const influencePoints = [...activeCutPoints, ...activePaintPoints];
        const activeCutPointKeys = new Set(activeCutPoints.map((point) => this.pointKey([point.position.x, point.position.z])));
        const mandatoryEstimate = regions.reduce((sum, region) => (
            sum + region.contour.length + region.holes.reduce((holeSum, hole) => holeSum + hole.length, 0)
        ), 0) + influencePoints.length + Math.max(0, sealedRoadSegments.length - roadBoundarySegments.length);
        const maxSteiner = Math.max(0, Math.floor((input.settings.triangleLimit - mandatoryEstimate) / 2));
        const steiner = this.generateSteinerPoints(
            input,
            regions,
            roadSegments,
            influencePoints,
            activeCutPoints,
            maxSteiner,
        );

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
            const essential = influencePoints.map((point) => [point.position.x, point.position.z] as Point2);
            triangles = this.insertRoadBoundaryKnots(
                this.triangulateRegions(regions, essential),
                roadBoundarySegments,
                input.cutAreas,
            );
        }

        this.assertRoadBoundariesAreSealed(triangles, sealedRoadSegments);

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
        const sealedRoadSegments = this.splitRoadSegmentsAtCutVertices(roadBoundarySegments, input.cutAreas);
        const roadSegments = this.mergeSegments(
            sealedRoadSegments,
            this.collectInfluenceBoundarySegments(input.influenceAreas ?? input.cutAreas),
        );
        const trianglesWithBoundaryKnots = this.insertRoadBoundaryKnots(triangles, roadBoundarySegments, input.cutAreas);
        this.assertRoadBoundariesAreSealed(trianglesWithBoundaryKnots, sealedRoadSegments);
        const activeCutPointKeys = new Set(input.cutPoints
            .filter((point) => this.doesCutPointInfluenceRegions(point, regions, point.radius))
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
        const triangles: [Point2, Point2, Point2][] = [];
        const regions: PolygonRegion[] = [];
        for (const rect of this.getFootprintRects(input)) {
            const contour = this.rectRing(rect).slice(0, 4);
            triangles.push([contour[0], contour[1], contour[2]]);
            triangles.push([contour[0], contour[2], contour[3]]);
            regions.push({ contour, holes: [] });
        }
        return {
            signature,
            triangles,
            regions,
            roadSegments: this.collectInfluenceBoundarySegments(input.influenceAreas ?? input.cutAreas),
            activeCutPointKeys: new Set(),
        };
    }

    private getFootprintRects(input: TerrainMesherInput): TerrainRect[] {
        if (input.footprint && input.footprint.length > 0) return input.footprint;
        return [{
            minX: input.center.x - input.width / 2,
            maxX: input.center.x + input.width / 2,
            minZ: input.center.z - input.length / 2,
            maxZ: input.center.z + input.length / 2,
        }];
    }

    private getFootprintBounds(input: TerrainMesherInput): TerrainRect {
        const rects = this.getFootprintRects(input);
        return {
            minX: Math.min(...rects.map((rect) => rect.minX)),
            maxX: Math.max(...rects.map((rect) => rect.maxX)),
            minZ: Math.min(...rects.map((rect) => rect.minZ)),
            maxZ: Math.max(...rects.map((rect) => rect.maxZ)),
        };
    }

    private rectRing(rect: TerrainRect): Ring {
        return [
            [rect.minX, rect.minZ], [rect.maxX, rect.minZ],
            [rect.maxX, rect.maxZ], [rect.minX, rect.maxZ], [rect.minX, rect.minZ],
        ].map((point) => this.snapPoint(point as Point2));
    }

    private buildFreeRegions(input: TerrainMesherInput): PolygonRegion[] {
        const rects = this.getFootprintRects(input);
        // Union first: the shared edges between touching tiles disappear here, which is
        // exactly what makes the group a single surface rather than several stitched ones.
        let surface: MultiPolygon = [[this.rectRing(rects[0])]];
        if (rects.length > 1) {
            const tiles = rects.map((rect) => [[this.rectRing(rect)]] as MultiPolygon);
            surface = ((polygonClipping as any).union(...tiles) as MultiPolygon | null) ?? surface;
        }

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
        const rects = this.getFootprintRects(input);
        for (const region of regions) {
            const rings = [region.contour, ...region.holes];
            for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
                const ring = rings[ringIndex];
                for (let i = 0; i < ring.length; i++) {
                    const a = ring[i];
                    const b = ring[(i + 1) % ring.length];
                    const isHoleBoundary = ringIndex > 0;
                    if (!isHoleBoundary && this.isTerrainOuterBoundarySegment(a, b, rects)) continue;
                    const key = this.edgeKey(a, b);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    result.push({ a, b });
                }
            }
        }
        return result;
    }

    private collectInfluenceBoundarySegments(areas: OccupiedTriangle[]): Segment2[] {
        const polygons: MultiPolygon[] = [];
        for (const triangle of areas) {
            const a = this.snapPoint([triangle.a.x, triangle.a.z]);
            const b = this.snapPoint([triangle.b.x, triangle.b.z]);
            const c = this.snapPoint([triangle.c.x, triangle.c.z]);
            if (Math.abs(this.signedArea([a, b, c])) <= TerrainMesher.EPSILON) continue;
            polygons.push([[[a, b, c, a]]]);
        }
        if (polygons.length === 0) return [];

        let union = polygons[0];
        for (let index = 1; index < polygons.length; index += 32) {
            const chunk = polygons.slice(index, index + 32);
            try {
                union = ((polygonClipping as any).union(union, ...chunk) as MultiPolygon | null) ?? union;
            } catch {
                for (const polygon of chunk) {
                    try {
                        union = ((polygonClipping as any).union(union, polygon) as MultiPolygon | null) ?? union;
                    } catch {
                        // Ignore invalid slivers; valid neighbouring triangles still constrain height.
                    }
                }
            }
        }

        const segments: Segment2[] = [];
        for (const polygon of union) {
            for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
                const ring = this.sanitizeRing(polygon[ringIndex], ringIndex > 0);
                for (let index = 0; index < ring.length; index++) {
                    const a = ring[index];
                    const b = ring[(index + 1) % ring.length];
                    if (this.distance(a, b) > TerrainMesher.EPSILON) segments.push({ a, b });
                }
            }
        }
        return segments;
    }

    private mergeSegments(...collections: Segment2[][]): Segment2[] {
        const result = new Map<string, Segment2>();
        for (const segments of collections) {
            for (const segment of segments) result.set(this.edgeKey(segment.a, segment.b), segment);
        }
        return [...result.values()];
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

    // A contour segment lying on one of the tile edge lines is the outer rim of the
    // surface, not a cutter boundary, so it must not pull heights toward a road. Edges
    // shared between two tiles never reach here: the union dissolved them.
    private isTerrainOuterBoundarySegment(a: Point2, b: Point2, rects: TerrainRect[]): boolean {
        const epsilon = TerrainMesher.BOUNDARY_EPSILON;
        const onSameBoundary = (valueA: number, valueB: number, boundary: number): boolean => (
            Math.abs(valueA - boundary) <= epsilon && Math.abs(valueB - boundary) <= epsilon
        );
        return rects.some((rect) => (
            onSameBoundary(a[0], b[0], rect.minX)
            || onSameBoundary(a[0], b[0], rect.maxX)
            || onSameBoundary(a[1], b[1], rect.minZ)
            || onSameBoundary(a[1], b[1], rect.maxZ)
        ));
    }

    private generateSteinerPoints(
        input: TerrainMesherInput,
        regions: PolygonRegion[],
        roadSegments: Segment2[],
        requiredPoints: TerrainCutPointInput[],
        adaptivePoints: TerrainCutPointInput[],
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

        for (const point of requiredPoints) {
            addExactPoint([point.position.x, point.position.z]);
        }

        if (result.length >= limit || roadSegments.length + adaptivePoints.length === 0) return result;

        const bounds = this.getFootprintBounds(input);
        const terrainDiagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
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

                    const distance = this.getNearestInfluenceDistance(point, roadSegments, adaptivePoints);
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
                for (const point of adaptivePoints) {
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

    private getActivePaintPoints(input: TerrainMesherInput, regions: PolygonRegion[]): TerrainCutPointInput[] {
        const paint = input.paint;
        if (!paint || paint.samples.length === 0) return [];
        const cellSize = Math.max(0.05, paint.cellSize);
        const candidates = paint.samples
            .filter((sample) => Math.abs(sample.height) > TerrainMesher.EPSILON)
            .map((sample) => ({
                sample,
                position: new THREE.Vector3(
                    Math.round(sample.gridX) * cellSize,
                    (input.baseHeight ?? input.center.y) + sample.height,
                    Math.round(sample.gridZ) * cellSize,
                ),
            }))
            .filter(({ position }) => (
                this.findContainingRegion([position.x, position.z], regions) !== null
                && !this.isInsideCutArea([position.x, position.z], input.cutAreas)
            ));
        const maxInfluences = Math.max(12, Math.min(
            160,
            Math.floor(input.settings.triangleLimit / 6),
            Math.floor(240 / Math.max(0.5, input.settings.meshDetail)),
        ));
        if (candidates.length <= maxInfluences) {
            return candidates.map(({ position }) => ({ position, radius: cellSize * 2 }));
        }

        const values = new Map<string, number>();
        for (const sample of paint.samples) {
            values.set(`${Math.round(sample.gridX)},${Math.round(sample.gridZ)}`, sample.height);
        }
        const importance = (sample: TerrainPaintHeightInput): number => {
            const x = Math.round(sample.gridX);
            const z = Math.round(sample.gridZ);
            const neighborSum = (values.get(`${x - 1},${z}`) ?? 0)
                + (values.get(`${x + 1},${z}`) ?? 0)
                + (values.get(`${x},${z - 1}`) ?? 0)
                + (values.get(`${x},${z + 1}`) ?? 0);
            return Math.abs(sample.height * 4 - neighborSum) + Math.abs(sample.height) * 0.02;
        };

        let blockSize = Math.max(2, Math.ceil(Math.sqrt(candidates.length / maxInfluences)));
        let selected: typeof candidates = [];
        do {
            const blocks = new Map<string, (typeof candidates)[number]>();
            for (const candidate of candidates) {
                const blockX = Math.floor(candidate.sample.gridX / blockSize);
                const blockZ = Math.floor(candidate.sample.gridZ / blockSize);
                const key = `${blockX},${blockZ}`;
                const current = blocks.get(key);
                if (!current || importance(candidate.sample) > importance(current.sample)) blocks.set(key, candidate);
            }
            selected = [...blocks.values()];
            blockSize++;
        } while (selected.length > maxInfluences);

        return selected
            .sort((a, b) => a.sample.gridZ - b.sample.gridZ || a.sample.gridX - b.sample.gridX)
            .map(({ position }) => ({ position, radius: cellSize * 2 }));
    }

    // How far a cut point actually reshapes the surface. Points carrying their own bank
    // slope stop at their radius; the rest fade out over the slope-derived width
    // applyHeights uses, and both terrains sharing an edge must agree on this number or
    // one of them drops the point and leaves a wall on the seam.
    private getCutPointInfluenceRadius(point: TerrainCutPointInput, input: TerrainMesherInput): number {
        const radius = Math.max(0, point.radius);
        if (point.profileOnly || point.maxSlopeDegrees !== undefined) return radius;
        const maxSlope = Math.max(0.01, Math.tan(THREE.MathUtils.degToRad(
            THREE.MathUtils.clamp(input.settings.maxSlopeDegrees, 1, 89),
        )));
        const baseHeight = input.baseHeight ?? input.center.y;
        return Math.max(radius, 1.5 * Math.abs(point.position.y - baseHeight) / maxSlope);
    }

    private doesCutPointInfluenceRegions(
        point: TerrainCutPointInput,
        regions: PolygonRegion[],
        radius: number,
    ): boolean {
        const position: Point2 = [point.position.x, point.position.z];
        return regions.some((region) => (
            this.isInsideRegion(position, region)
            || this.getDistanceToRegionBoundary(position, region) <= radius + TerrainMesher.EPSILON
        ));
    }

    private applyHeights(topology: TopologyCache, input: TerrainMesherInput): OccupiedTriangle[] {
        const cutPointMap = new Map<string, TerrainCutPointInput>();
        for (const point of input.cutPoints) {
            const key = this.pointKey([point.position.x, point.position.z]);
            if (topology.activeCutPointKeys.has(key)) cutPointMap.set(key, point);
        }
        const influencingCutPoints = input.cutPoints
            .filter((point) => !point.profileOnly)
            .map((point) => ({ point, radius: this.getCutPointInfluenceRadius(point, input) }))
            .filter(({ point, radius }) => (
                this.doesCutPointInfluenceRegions(point, topology.regions, radius)
                && !this.isInsideCutArea([point.position.x, point.position.z], input.cutAreas)
            ));
        const paintCellSize = Math.max(0.05, input.paint?.cellSize ?? 1);
        const paintValues = new Map<string, number>();
        for (const sample of input.paint?.samples ?? []) {
            paintValues.set(`${Math.round(sample.gridX)},${Math.round(sample.gridZ)}`, sample.height);
        }
        const paintedHeightAt = (point: Point2): number => {
            if (paintValues.size === 0) return 0;
            const gridX = point[0] / paintCellSize;
            const gridZ = point[1] / paintCellSize;
            const x0 = Math.floor(gridX);
            const z0 = Math.floor(gridZ);
            const tx = gridX - x0;
            const tz = gridZ - z0;
            const read = (x: number, z: number): number => paintValues.get(`${x},${z}`) ?? 0;
            const bottom = THREE.MathUtils.lerp(read(x0, z0), read(x0 + 1, z0), tx);
            const top = THREE.MathUtils.lerp(read(x0, z0 + 1), read(x0 + 1, z0 + 1), tx);
            return THREE.MathUtils.lerp(bottom, top, tz);
        };
        const roadHeightSegments: HeightSegment[] = [];
        const heightInfluenceAreas = input.influenceAreas ?? input.cutAreas;
        for (const segment of topology.roadSegments) {
            const midpoint: Point2 = [(segment.a[0] + segment.b[0]) / 2, (segment.a[1] + segment.b[1]) / 2];
            const fallback = this.sampleCutBoundary(midpoint, heightInfluenceAreas);
            const sampleA = this.sampleCutBoundary(segment.a, heightInfluenceAreas) ?? fallback;
            const sampleB = this.sampleCutBoundary(segment.b, heightInfluenceAreas) ?? fallback;
            if (!sampleA || !sampleB) continue;
            // A boundary triangle can override the terrain's global max slope (e.g. a river
            // wanting a steep bank instead of the wide, gentle blend a road would want).
            const slopeOverride = sampleA.slopeDegrees ?? sampleB.slopeDegrees;
            const slopeDegrees = slopeOverride ?? input.settings.maxSlopeDegrees;
            const segmentMaxSlope = Math.max(0.01, Math.tan(THREE.MathUtils.degToRad(THREE.MathUtils.clamp(slopeDegrees, 1, 89))));
            roadHeightSegments.push({
                ...segment,
                heightA: sampleA.height,
                heightB: sampleB.height,
                maxSlope: segmentMaxSlope,
                usesTerrainSlope: slopeOverride === undefined,
            });
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

            const paintedBaseHeight = (input.baseHeight ?? input.center.y) + paintedHeightAt(point);
            const smoothingEnabled = input.settings.smoothingEnabled;
            const smoothingRadius = input.settings.smoothingRadius;
            if (!smoothingEnabled) {
                heightCache.set(key, paintedBaseHeight);
                return paintedBaseHeight;
            }

            let weightedDelta = 0;
            let weightSum = 0;
            if (road) {
                const roadMaxSlope = road.maxSlope;
                const width = Math.max(smoothingRadius, 1.5 * Math.abs(road.height - paintedBaseHeight) / roadMaxSlope);
                const weight = this.smoothInfluence(road.distance, width);
                weightedDelta += (road.height - paintedBaseHeight) * weight;
                weightSum += weight;
            }
            // Cut points combine as a union of profiles, not as a sum. Each point's radius
            // is sized so its own profile never exceeds the max slope, but adding
            // overlapping influences together multiplied that gradient by however many
            // points happened to overlap - a spline sampled every couple of units used to
            // carve a near vertical wall out of a 35 degree bank. Taking the deepest (and
            // the highest) profile keeps every point's slope limit intact no matter how
            // many of them pile up.
            let lowestProfile: number | null = null;
            let highestProfile: number | null = null;
            for (const { point: cutPoint, radius } of influencingCutPoints) {
                const distance = Math.hypot(point[0] - cutPoint.position.x, point[1] - cutPoint.position.z);
                if (distance > radius) continue;
                const t = radius <= TerrainMesher.EPSILON
                    ? 1
                    : THREE.MathUtils.clamp(distance / radius, 0, 1);
                const smoothT = t * t * (3 - 2 * t);
                // A point carrying its own bank slope keeps its straight-to-rounded profile
                // control. Points on the terrain-wide slope always use the rounded profile
                // their radius was sized for.
                const smoothing = cutPoint.maxSlopeDegrees === undefined
                    ? 1
                    : THREE.MathUtils.clamp(cutPoint.slopeSmoothing ?? 0, 0, 1);
                const profileT = THREE.MathUtils.lerp(t, smoothT, smoothing);
                const candidate = THREE.MathUtils.lerp(cutPoint.position.y, paintedBaseHeight, profileT);
                if (candidate < paintedBaseHeight) {
                    lowestProfile = lowestProfile === null ? candidate : Math.min(lowestProfile, candidate);
                } else if (candidate > paintedBaseHeight) {
                    highestProfile = highestProfile === null ? candidate : Math.max(highestProfile, candidate);
                }
            }
            let height = paintedBaseHeight + weightedDelta / Math.max(1, weightSum);
            if (lowestProfile !== null) height = Math.min(height, lowestProfile);
            if (highestProfile !== null) height = Math.max(height, highestProfile);
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

    private getNearestRoadConstraint(
        point: Point2,
        segments: HeightSegment[],
    ): { distance: number; height: number; maxSlope: number; usesTerrainSlope: boolean } | null {
        let best: { distance: number; height: number; maxSlope: number; usesTerrainSlope: boolean } | null = null;
        for (const segment of segments) {
            const projection = this.projectToSegment(point, segment.a, segment.b);
            const height = segment.heightA + (segment.heightB - segment.heightA) * projection.t;
            if (!best || projection.distance < best.distance) {
                best = {
                    distance: projection.distance,
                    height,
                    maxSlope: segment.maxSlope,
                    usesTerrainSlope: segment.usesTerrainSlope,
                };
            }
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
        const influenceAreaKeys = (input.influenceAreas ?? input.cutAreas).map((tri) => [tri.a, tri.b, tri.c]
            .map((point) => this.pointKey([point.x, point.z])).sort().join(';')).sort();
        const pointKeys = input.cutPoints.map((point) => [
            this.pointKey([point.position.x, point.position.z]),
            this.snap(point.radius),
            point.profileOnly ? 1 : 0,
        ].join('@')).sort();
        const paintKeys = (input.paint?.samples ?? [])
            .filter((sample) => Math.abs(sample.height) > TerrainMesher.EPSILON)
            .map((sample) => `${Math.round(sample.gridX)},${Math.round(sample.gridZ)}`)
            .sort();
        const footprintKeys = this.getFootprintRects(input)
            .map((rect) => [rect.minX, rect.maxX, rect.minZ, rect.maxZ].map((value) => this.snap(value)).join(','))
            .sort();
        return [
            this.snap(input.baseHeight ?? input.center.y),
            footprintKeys.join('|'),
            this.snap(input.settings.meshDetail), Math.round(input.settings.triangleLimit),
            input.settings.smoothingEnabled ? 1 : 0,
            this.snap(input.settings.smoothingRadius),
            cutterKeys.join('|'), influenceAreaKeys.join('|'), pointKeys.join('|'),
            this.snap(input.paint?.cellSize ?? 1), paintKeys.join('|'),
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
