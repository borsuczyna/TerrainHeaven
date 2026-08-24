import * as THREE from 'three';
import * as polygonClipping from 'polygon-clipping';
import WorldElement, {
    type ElementData,
    type GeometryGroup,
    type NodeBasis,
    type OccupiedTriangle,
    type UVTransform,
} from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import type { PropertyDefinition, SectionItem } from '../editor/Properties';

type Point2 = [number, number];
type Ring = Point2[];
type MultiPolygon = Point2[][][];

export interface BuildingSegment {
    width: number;
    depth: number;
    wallHeight?: number;
    roofRidgeHeight?: number;
    roofOverhang?: number;
    roofDirection?: RoofDirection;
}

export type RoofType = 'flat' | 'gable';
export type OpeningType = 'window' | 'door';
// Gable roofs only: which axis the ridge runs along. 'auto' picks whichever of the
// segment's own width/depth is larger (a wide, shallow segment gets a ridge running along
// its width, and vice versa) - the same rule used before this was configurable. 'x'/'z'
// pin the ridge to that axis regardless of the segment's proportions.
export type RoofDirection = 'auto' | 'x' | 'z';

interface SegmentEntry {
    width: number;
    depth: number;
    node: WorldNode;
    wallHeight: number;
    roofRidgeHeight: number;
    roofOverhang: number;
    roofDirection: RoofDirection;
}

interface OpeningEntry {
    type: OpeningType;
    width: number;
    height: number;
    depth: number;
    node: WorldNode;
}

interface FootprintPolygon {
    contour: Ring;
    holes: Ring[];
}

interface WallEdge {
    a: Point2;
    b: Point2;
}

interface WallOpening {
    u: number;
    width: number;
    height: number;
    sill: number;
    depth: number;
    type: OpeningType;
}

const SEGMENT_NODE_COLOR = 0x4da6ff;
const OPENING_NODE_COLOR = 0xffa64d;
const MIN_SEGMENT_SIZE = 1;
const WALL_SNAP_DISTANCE = 0.6;
const WALL_SNAP_MARGIN = 0.3;
const HEIGHT_SNAP_MARGIN = 0.25;
// Segments are padded by this much before the boolean union in computeFootprintPolygons -
// polygon-clipping's touching-detection is only numerically reliable when two rects actually
// overlap, not when their edges merely coincide to within floating-point or hand-placement
// precision, so two segments meant to sit flush would merge or not merge from one rebuild to
// the next depending on tiny drift. Segments don't need a pixel-perfect shared edge to read
// as one connected building - padding guarantees real overlap so the union always succeeds,
// at the cost of a few centimetres of extra footprint that isn't worth clawing back with a
// second erode pass.
const FOOTPRINT_UNION_PADDING = 0.1;
const DEFAULT_WALL_HEIGHT = 3;
const DEFAULT_ROOF_RIDGE_HEIGHT = 1.6;
const DEFAULT_ROOF_OVERHANG = 0.4;

// A multi-room building: one or more rectangular footprint segments (unioned via the same
// polygon-clipping approach TerrainMesher uses for touching terrain tiles) extruded into
// walls, with window/door openings cut directly into whichever wall they sit against, and a
// flat-with-parapet or gable roof capping it. Node 0 is the building's own anchor (a "move
// everything" handle); nodes 1+ are one per segment, then one per opening. Every segment
// and every opening carries its own real world-space node - not an anchor-relative offset -
// so each is independently selectable and draggable in the viewport (the same node-based
// pattern PolygonTerrain uses, and for the same reason: GizmoManager moves every node of a
// multi-node element together when the whole element is dragged, so nothing here can go
// stale the way a separately-stored offset or sill height used to).
export default class Building extends WorldElement {
    public roofType: RoofType = 'flat';
    public roofThickness = 0.15;
    public railingHeight = 1;
    public railingThickness = 0.15;
    // Off by default: a building sitting on top of a rectangular Terrain tile used to
    // always punch a hole under itself with no way to opt out, which is wrong for e.g. a
    // building meant to float above a slope or sit on an existing platform.
    public cutInGround = false;

    private segments: SegmentEntry[];
    private openings: OpeningEntry[] = [];
    private wallUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    private roofUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    private railingUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    private gableWallUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    private windowUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    private doorUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

    constructor(anchor: THREE.Vector3, firstSegment: BuildingSegment) {
        super();
        this.mesh.castShadow = true;
        this.setNode(0, new WorldNode(anchor.clone(), Config.editor.nodeColor));
        const segmentNode = new WorldNode(anchor.clone(), SEGMENT_NODE_COLOR);
        this.setNode(1, segmentNode);
        this.segments = [{
            width: Math.max(MIN_SEGMENT_SIZE, firstSegment.width),
            depth: Math.max(MIN_SEGMENT_SIZE, firstSegment.depth),
            node: segmentNode,
            wallHeight: Math.max(0.5, firstSegment.wallHeight ?? DEFAULT_WALL_HEIGHT),
            roofRidgeHeight: Math.max(0.1, firstSegment.roofRidgeHeight ?? DEFAULT_ROOF_RIDGE_HEIGHT),
            roofOverhang: Math.max(0, firstSegment.roofOverhang ?? DEFAULT_ROOF_OVERHANG),
            roofDirection: firstSegment.roofDirection ?? 'auto',
        }];
    }

    public override update(): void {
        super.update();
        // Defensive, matching Terrain/PolygonTerrain: winding is verified correct for every
        // face this class builds, but double-siding costs nothing noticeable for a handful
        // of prop-sized meshes and means a future winding slip goes unnoticed as a lighting
        // quirk rather than a face silently disappearing.
        const mats = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
        for (const mat of mats) {
            const material = mat as THREE.MeshStandardMaterial;
            material.side = THREE.DoubleSide;
            material.needsUpdate = true;
        }
    }

    public override cutsTerrainSurface(): boolean {
        return this.cutInGround;
    }

    private getAnchor(): THREE.Vector3 {
        return this.nodes[0].mesh.position;
    }

    // Read-only world position, for tools computing a new segment/opening's placement from
    // a raycast hit without needing to duplicate the anchor-node lookup.
    public getAnchorPosition(): THREE.Vector3 {
        return this.getAnchor().clone();
    }

    public get segmentCount(): number {
        return this.segments.length;
    }

    public getSegment(index: number): BuildingSegment {
        const entry = this.segments[index];
        return {
            width: entry.width,
            depth: entry.depth,
            wallHeight: entry.wallHeight,
            roofRidgeHeight: entry.roofRidgeHeight,
            roofOverhang: entry.roofOverhang,
            roofDirection: entry.roofDirection,
        };
    }

    public getSegmentNode(index: number): WorldNode {
        return this.segments[index].node;
    }

    public addSegment(
        position: THREE.Vector3,
        width: number,
        depth: number,
        options?: { wallHeight?: number; roofRidgeHeight?: number; roofOverhang?: number; roofDirection?: RoofDirection },
    ): void {
        const node = new WorldNode(position.clone(), SEGMENT_NODE_COLOR);
        this.setNode(this.nodes.length, node);
        this.segments.push({
            width: Math.max(MIN_SEGMENT_SIZE, width),
            depth: Math.max(MIN_SEGMENT_SIZE, depth),
            node,
            wallHeight: Math.max(0.5, options?.wallHeight ?? DEFAULT_WALL_HEIGHT),
            roofRidgeHeight: Math.max(0.1, options?.roofRidgeHeight ?? DEFAULT_ROOF_RIDGE_HEIGHT),
            roofOverhang: Math.max(0, options?.roofOverhang ?? DEFAULT_ROOF_OVERHANG),
            roofDirection: options?.roofDirection ?? 'auto',
        });
        this.update();
    }

    public removeSegment(index: number): boolean {
        if (this.segments.length <= 1 || index < 0 || index >= this.segments.length) return false;
        this.removeTrackedNode(this.segments[index].node);
        this.segments.splice(index, 1);
        this.update();
        return true;
    }

    // Walls, world-space, so callers (the segment/opening placement tools) can find the
    // nearest wall of an already-built building without duplicating the union math.
    public getWallEdges(): WallEdge[] {
        return this.collectWallEdges(this.computeFootprintPolygons());
    }

    public get openingCount(): number {
        return this.openings.length;
    }

    public getOpeningNode(index: number): WorldNode {
        return this.openings[index].node;
    }

    public getOpeningData(index: number): { type: OpeningType; width: number; height: number; depth: number } {
        const entry = this.openings[index];
        return { type: entry.type, width: entry.width, height: entry.height, depth: entry.depth };
    }

    public addOpening(worldPosition: THREE.Vector3, type: OpeningType): void {
        const node = new WorldNode(worldPosition.clone(), OPENING_NODE_COLOR);
        this.setNode(this.nodes.length, node);
        this.openings.push(type === 'door'
            ? { type, width: 0.9, height: 2.05, depth: 0.1, node }
            : { type, width: 1.2, height: 1.2, depth: 0.1, node });
        this.update();
    }

    public removeOpening(index: number): boolean {
        const entry = this.openings[index];
        if (!entry) return false;
        this.removeTrackedNode(entry.node);
        this.openings.splice(index, 1);
        this.update();
        return true;
    }

    private removeTrackedNode(node: WorldNode): void {
        const index = this.nodes.indexOf(node);
        if (index < 0) return;
        this.mesh.remove(node.mesh);
        node.dispose();
        this.nodes.splice(index, 1);
    }

    public override getNodeBasis(_index: number): NodeBasis {
        return {
            forward: new THREE.Vector3(1, 0, 0),
            right: new THREE.Vector3(0, 0, 1),
            up: new THREE.Vector3(0, 1, 0),
        };
    }

    public override getUVGroups(): string[] {
        return ['walls', 'roof', 'railing', 'gableWalls', 'windows', 'doors'];
    }

    public override getUVTransform(group: string): UVTransform {
        const map = this.uvMapFor(group);
        return map ? { ...map } : super.getUVTransform(group);
    }

    public override setUVTransform(group: string, transform: UVTransform): void {
        const current = this.uvMapFor(group);
        if (!current) {
            super.setUVTransform(group, transform);
            return;
        }
        const next: UVTransform = {
            offsetX: Number.isFinite(transform.offsetX) ? transform.offsetX : 0,
            offsetY: Number.isFinite(transform.offsetY) ? transform.offsetY : 0,
            scaleX: Number.isFinite(transform.scaleX) ? Math.max(0.05, transform.scaleX) : 1,
            scaleY: Number.isFinite(transform.scaleY) ? Math.max(0.05, transform.scaleY) : 1,
        };
        if (group === 'walls') this.wallUV = next;
        else if (group === 'roof') this.roofUV = next;
        else if (group === 'railing') this.railingUV = next;
        else if (group === 'gableWalls') this.gableWallUV = next;
        else if (group === 'windows') this.windowUV = next;
        else this.doorUV = next;
        this.update();
    }

    private uvMapFor(group: string): UVTransform | null {
        if (group === 'walls') return this.wallUV;
        if (group === 'roof') return this.roofUV;
        if (group === 'railing') return this.railingUV;
        if (group === 'gableWalls') return this.gableWallUV;
        if (group === 'windows') return this.windowUV;
        if (group === 'doors') return this.doorUV;
        return null;
    }

    public override getOccupiedArea(): OccupiedTriangle[] {
        const anchorY = this.getAnchor().y;
        const result: OccupiedTriangle[] = [];
        for (const polygon of this.computeFootprintPolygons()) {
            for (const triangle of this.triangulatePolygon(polygon)) {
                const at = (p: THREE.Vector2): THREE.Vector3 => new THREE.Vector3(p.x, anchorY, p.y);
                result.push({ a: at(triangle[0]), b: at(triangle[1]), c: at(triangle[2]) });
            }
        }
        return result;
    }

    // Segments sharing the same wall height (rounded to the millimetre) are unioned into one
    // real merged footprint - the same polygon-clipping approach used everywhere else, with
    // the same padding - so touching same-height segments share one seamless wall loop (and,
    // for flat roofs, one slab and parapet loop) with no interior seam. Segments at a
    // different height simply can't share a wall loop (there's no single top height that
    // would fit both), so they fall into their own group and get their own fully independent
    // walls - stepping a single shared wall loop down at the height boundary was tried and
    // produced broken, inconsistent notch geometry, so this deliberately does not attempt
    // that: differently-tall segments always get separate, non-optimized, possibly
    // overlapping wall loops instead of one clever-but-fragile stepped one.
    private groupSegmentsByHeight(): SegmentEntry[][] {
        const groups = new Map<number, SegmentEntry[]>();
        for (const segment of this.segments) {
            const key = Math.round(segment.wallHeight * 1000);
            const group = groups.get(key);
            if (group) group.push(segment);
            else groups.set(key, [segment]);
        }
        return [...groups.values()];
    }

    protected override getGeometry(): GeometryGroup[] {
        const anchor = this.getAnchor();
        const windows: Triangle[] = [];
        const doors: Triangle[] = [];
        const wallTriangles: Triangle[] = [];
        const roofTriangles: Triangle[] = [];
        const railingTriangles: Triangle[] = [];
        const gableWalls: Triangle[] = [];

        // Every segment always gets its own gable roof, sized to its own rectangle and built
        // from its own wall height, ridge height and overhang - no merged/shared roof. Where
        // two touching segments' roof volumes overlap, they simply interpenetrate rather than
        // forming a true architectural valley - real hip/valley intersection is a straight-
        // skeleton problem well beyond what a level editor's prop building needs.
        if (this.roofType === 'gable') {
            for (const segment of this.segments) {
                const ridgeAlongX = segment.roofDirection === 'x' ? true
                    : segment.roofDirection === 'z' ? false
                    : segment.width >= segment.depth;
                roofTriangles.push(...this.buildGableRoofForRect(
                    segment.node.mesh.position.x, segment.node.mesh.position.z, segment.width, segment.depth,
                    anchor.y + segment.wallHeight, segment.roofRidgeHeight, segment.roofOverhang, ridgeAlongX,
                    gableWalls, windows, doors,
                ));
            }
        }

        for (const group of this.groupSegmentsByHeight()) {
            const groupHeight = group[0].wallHeight;
            const topY = anchor.y + groupHeight;
            const groupPolygons = this.computeFootprintPolygons(group);
            const groupEdges = this.collectWallEdges(groupPolygons);
            wallTriangles.push(...this.buildWallStrip(groupEdges, anchor.y, groupHeight, this.wallUV, true, windows, doors));

            if (this.roofType === 'flat') {
                roofTriangles.push(...this.buildFlatRoofSlab(groupPolygons, groupEdges, topY));
                railingTriangles.push(...this.buildParapetStrip(
                    groupEdges, topY, Math.max(0.1, this.railingHeight), Math.max(0.02, this.railingThickness), this.railingUV,
                ));
            }
        }

        return [
            { name: 'walls', triangles: wallTriangles },
            { name: 'roof', triangles: roofTriangles },
            { name: 'railing', triangles: railingTriangles },
            { name: 'gableWalls', triangles: gableWalls },
            { name: 'windows', triangles: windows },
            { name: 'doors', triangles: doors },
        ];
    }

    public getExportGeometry(_lodIndex: number): GeometryGroup[] {
        return this.getGeometry();
    }

    // --- footprint -----------------------------------------------------------------

    private computeFootprintPolygons(segments: SegmentEntry[] = this.segments): FootprintPolygon[] {
        if (segments.length === 0) return [];
        const rectRing = (segment: SegmentEntry): Ring => {
            const cx = segment.node.mesh.position.x;
            const cz = segment.node.mesh.position.z;
            const hw = Math.max(MIN_SEGMENT_SIZE, segment.width) / 2 + FOOTPRINT_UNION_PADDING;
            const hd = Math.max(MIN_SEGMENT_SIZE, segment.depth) / 2 + FOOTPRINT_UNION_PADDING;
            return [[cx - hw, cz - hd], [cx + hw, cz - hd], [cx + hw, cz + hd], [cx - hw, cz + hd]];
        };

        let surface: MultiPolygon = [[rectRing(segments[0])]];
        if (segments.length > 1) {
            const polys = segments.map((segment) => [[rectRing(segment)]] as MultiPolygon);
            surface = ((polygonClipping as any).union(...polys) as MultiPolygon | null) ?? surface;
        }

        const result: FootprintPolygon[] = [];
        for (const polygon of surface) {
            if (polygon.length === 0) continue;
            const contour = this.sanitizeRing(polygon[0]);
            if (contour.length < 3) continue;
            const holes = polygon.slice(1).map((ring) => this.sanitizeRing(ring)).filter((ring) => ring.length >= 3);
            result.push({ contour, holes });
        }
        return result;
    }

    private sanitizeRing(source: Point2[]): Ring {
        const snap = (v: number): number => Math.round(v * 1e5) / 1e5;
        const ring: Ring = [];
        for (const raw of source) {
            const point: Point2 = [snap(raw[0]), snap(raw[1])];
            const last = ring[ring.length - 1];
            if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 1e-4) ring.push(point);
        }
        if (ring.length > 1) {
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-4) ring.pop();
        }
        let changed = true;
        while (changed && ring.length > 3) {
            changed = false;
            for (let i = 0; i < ring.length; i++) {
                const prev = ring[(i - 1 + ring.length) % ring.length];
                const curr = ring[i];
                const next = ring[(i + 1) % ring.length];
                const area = (curr[0] - prev[0]) * (next[1] - prev[1]) - (curr[1] - prev[1]) * (next[0] - prev[0]);
                if (Math.abs(area) < 1e-6) {
                    ring.splice(i, 1);
                    changed = true;
                    break;
                }
            }
        }
        return ring;
    }

    private collectWallEdges(polygons: FootprintPolygon[]): WallEdge[] {
        const edges: WallEdge[] = [];
        for (const { contour, holes } of polygons) {
            for (const ring of [contour, ...holes]) {
                for (let i = 0; i < ring.length; i++) edges.push({ a: ring[i], b: ring[(i + 1) % ring.length] });
            }
        }
        return edges;
    }

    // Triangulates a footprint polygon and corrects triangle winding so the top face
    // consistently faces +Y - THREE.ShapeUtils.triangulateShape's own winding depends on
    // the contour's 2D orientation, which the (x, z) -> (x, worldY, z) mapping here doesn't
    // automatically line up with "faces up" (see PolygonTerrain for the same correction on
    // the same kind of footprint-to-3D mapping).
    private triangulatePolygon(polygon: FootprintPolygon): [THREE.Vector2, THREE.Vector2, THREE.Vector2][] {
        const contour = polygon.contour.map(([x, z]) => new THREE.Vector2(x, z));
        const holes = polygon.holes.map((hole) => hole.map(([x, z]) => new THREE.Vector2(x, z)));
        const indices = THREE.ShapeUtils.triangulateShape(contour, holes);
        const points = [...contour, ...holes.flat()];
        return indices.map(([ia, ib, ic]) => {
            const pa = points[ia];
            let pb = points[ib];
            let pc = points[ic];
            if (this.signedArea2D(pa, pb, pc) > 0) [pb, pc] = [pc, pb];
            return [pa, pb, pc];
        });
    }

    private signedArea2D(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): number {
        return ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }

    // --- walls (box-strip extrusion) -------------------------------

    // Builds a vertical strip of quads (with rectangular holes cut in for any window/door
    // that falls within [baseY, baseY+height], plus a small margin) along a set of world-
    // space edges. windowsOut/doorsOut collect the 3D frame/pane inserts for any opening
    // actually cut (see appendOpeningInsert).
    private buildWallStrip(
        edges: WallEdge[],
        baseY: number,
        height: number,
        uv: UVTransform,
        withOpenings: boolean,
        windowsOut: Triangle[],
        doorsOut: Triangle[],
    ): Triangle[] {
        if (edges.length === 0 || height <= 0) return [];
        const centroid = this.computeEdgeCentroid(edges);
        const triangles: Triangle[] = [];

        for (const edge of edges) {
            let a2 = edge.a;
            let b2 = edge.b;
            const rawDir = new THREE.Vector3(b2[0] - a2[0], 0, b2[1] - a2[1]);
            const length = rawDir.length();
            if (length < 1e-4) continue;
            const dir = rawDir.clone().normalize();
            const faceNormal = new THREE.Vector3(-dir.z, 0, dir.x);
            const mid = new THREE.Vector3((a2[0] + b2[0]) / 2, 0, (a2[1] + b2[1]) / 2);
            if (faceNormal.dot(mid.clone().sub(centroid)) < 0) {
                [a2, b2] = [b2, a2];
            }
            const openings = withOpenings ? this.collectOpeningsForEdge(a2, b2, baseY, baseY + height) : [];
            this.appendWallSegment(triangles, a2, b2, baseY, height, uv, openings, windowsOut, doorsOut);
        }
        return triangles;
    }

    private computeEdgeCentroid(edges: WallEdge[]): THREE.Vector3 {
        const centroid = new THREE.Vector3();
        for (const edge of edges) centroid.add(new THREE.Vector3(edge.a[0], 0, edge.a[1]));
        return centroid.multiplyScalar(edges.length > 0 ? 1 / edges.length : 0);
    }

    private appendWallSegment(
        out: Triangle[],
        a2: Point2,
        b2: Point2,
        baseY: number,
        height: number,
        uv: UVTransform,
        openings: WallOpening[],
        windowsOut: Triangle[],
        doorsOut: Triangle[],
    ): void {
        const dir = new THREE.Vector3(b2[0] - a2[0], 0, b2[1] - a2[1]);
        const length = dir.length();
        dir.normalize();
        // a2->b2 has already been oriented outward by buildWallStrip's centroid check, so
        // this cross-style normal is guaranteed to point away from the building here too.
        const outward = new THREE.Vector3(-dir.z, 0, dir.x);
        const point3 = (u: number, v: number): THREE.Vector3 => new THREE.Vector3(a2[0] + dir.x * u, baseY + v, a2[1] + dir.z * u);
        const uvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * uv.scaleX + uv.offsetX, v * uv.scaleY + uv.offsetY);
        const addQuad = (u0: number, v0: number, u1: number, v1: number): void => {
            const p0 = point3(u0, v0);
            const p1 = point3(u1, v0);
            const p2 = point3(u1, v1);
            const p3 = point3(u0, v1);
            out.push(new Triangle(p0, p1, p2, uvFor(u0, v0), uvFor(u1, v0), uvFor(u1, v1)));
            out.push(new Triangle(p0, p2, p3, uvFor(u0, v0), uvFor(u1, v1), uvFor(u0, v1)));
        };

        const holes: THREE.Vector2[][] = [];
        for (const opening of openings) {
            const halfWidth = opening.width / 2;
            const u0 = THREE.MathUtils.clamp(opening.u - halfWidth, WALL_SNAP_MARGIN, length - WALL_SNAP_MARGIN);
            const u1 = THREE.MathUtils.clamp(opening.u + halfWidth, WALL_SNAP_MARGIN, length - WALL_SNAP_MARGIN);
            if (u1 - u0 < 0.1) continue;
            const v0 = THREE.MathUtils.clamp(opening.sill, 0.02, height - 0.05);
            const v1 = THREE.MathUtils.clamp(opening.sill + opening.height, v0 + 0.05, height - 0.02);
            holes.push([new THREE.Vector2(u0, v0), new THREE.Vector2(u1, v0), new THREE.Vector2(u1, v1), new THREE.Vector2(u0, v1)]);
            this.appendOpeningInsert(
                opening.type === 'door' ? doorsOut : windowsOut,
                out,
                point3, outward, u0, v0, u1, v1, opening.depth,
                opening.type === 'door' ? this.doorUV : this.windowUV,
                uv,
            );
        }

        if (holes.length === 0) {
            addQuad(0, 0, length, height);
            return;
        }

        const contour = [new THREE.Vector2(0, 0), new THREE.Vector2(length, 0), new THREE.Vector2(length, height), new THREE.Vector2(0, height)];
        const indices = THREE.ShapeUtils.triangulateShape(contour, holes);
        const points = [...contour, ...holes.flat()];
        for (const [ia, ib, ic] of indices) {
            const pa = points[ia];
            const pb = points[ib];
            const pc = points[ic];
            out.push(new Triangle(
                point3(pa.x, pa.y), point3(pb.x, pb.y), point3(pc.x, pc.y),
                uvFor(pa.x, pa.y), uvFor(pb.x, pb.y), uvFor(pc.x, pc.y),
            ));
        }
    }

    // A window/door is never just an empty hole: this builds the recessed pane (the glass
    // or door slab, its own texturable surface, into paneOut/paneUv) set `depth` back from
    // the wall's outward face, plus reveal strips closing the four sides of the recess
    // (into revealOut/revealUv - the surrounding wall's own material, not the pane's, since
    // the reveal is physically part of that wall, not the window/door itself).
    private appendOpeningInsert(
        paneOut: Triangle[],
        revealOut: Triangle[],
        point3: (u: number, v: number) => THREE.Vector3,
        outward: THREE.Vector3,
        u0: number,
        v0: number,
        u1: number,
        v1: number,
        depth: number,
        paneUv: UVTransform,
        revealUv: UVTransform,
    ): void {
        const paneUvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * paneUv.scaleX + paneUv.offsetX, v * paneUv.scaleY + paneUv.offsetY);
        const revealUvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * revealUv.scaleX + revealUv.offsetX, v * revealUv.scaleY + revealUv.offsetY);
        const recessDepth = Math.max(0.02, depth);
        const inward = outward.clone().multiplyScalar(-recessDepth);
        const outer = [point3(u0, v0), point3(u1, v0), point3(u1, v1), point3(u0, v1)];
        const inner = outer.map((p) => p.clone().add(inward));

        // Recessed pane - same winding as the outer loop (a pure translation preserves the
        // outward-facing normal), so it faces the same way the wall's own surface does.
        paneOut.push(new Triangle(inner[0], inner[1], inner[2], paneUvFor(0, 0), paneUvFor(1, 0), paneUvFor(1, 1)));
        paneOut.push(new Triangle(inner[0], inner[2], inner[3], paneUvFor(0, 0), paneUvFor(1, 1), paneUvFor(0, 1)));

        for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            const edgeLength = outer[i].distanceTo(outer[j]);
            revealOut.push(new Triangle(outer[j], outer[i], inner[i], revealUvFor(0, 0), revealUvFor(edgeLength, 0), revealUvFor(edgeLength, recessDepth)));
            revealOut.push(new Triangle(outer[j], inner[i], inner[j], revealUvFor(0, 0), revealUvFor(edgeLength, recessDepth), revealUvFor(0, recessDepth)));
        }
    }

    // Position-based, not id-based: an opening just carries a world-space node, so it is
    // matched against whichever wall it currently sits closest to every time geometry is
    // rebuilt. Moving the opening (or reshaping the segment the wall belongs to) never
    // leaves a stale reference to clean up - the opening simply stops cutting a hole
    // anywhere once it's far enough from every wall. The sill height is read directly from
    // the node's own Y (relative to the building's base) rather than a separately stored
    // field, which is what makes dragging the node up/down actually move the hole.
    //
    // minY/maxY gates the match to this particular wall's own vertical span (with a small
    // margin): without it, a gable wall and the ordinary wall directly beneath it share the
    // exact same (x, z) line, so an opening meant for one would also match the other and
    // cut a second, wrongly-clamped hole whichever wall it doesn't belong to.
    private collectOpeningsForEdge(a2: Point2, b2: Point2, minY: number, maxY: number): WallOpening[] {
        const length = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
        if (length < 1e-4) return [];
        const dx = (b2[0] - a2[0]) / length;
        const dz = (b2[1] - a2[1]) / length;
        const anchorY = this.getAnchor().y;
        const result: WallOpening[] = [];

        for (const entry of this.openings) {
            const pos = entry.node.mesh.position;
            if (pos.y < minY - HEIGHT_SNAP_MARGIN || pos.y > maxY + HEIGHT_SNAP_MARGIN) continue;
            const relX = pos.x - a2[0];
            const relZ = pos.z - a2[1];
            const t = relX * dx + relZ * dz;
            if (t < -WALL_SNAP_MARGIN || t > length + WALL_SNAP_MARGIN) continue;
            const perp = Math.abs(relX * dz - relZ * dx);
            if (perp > WALL_SNAP_DISTANCE) continue;
            result.push({
                u: THREE.MathUtils.clamp(t, 0, length),
                width: entry.width,
                height: entry.height,
                sill: pos.y - anchorY,
                depth: entry.depth,
                type: entry.type,
            });
        }
        return result;
    }

    // --- roofs -------------------------------------------------------------------

    private buildFlatRoofSlab(polygons: FootprintPolygon[], edges: WallEdge[], topY: number): Triangle[] {
        const thickness = Math.max(0.02, this.roofThickness);
        const bottomY = topY - thickness;
        const uv = this.roofUV;
        const uvFor = (p: THREE.Vector2): THREE.Vector2 => new THREE.Vector2(p.x * 0.2 * uv.scaleX + uv.offsetX, p.y * 0.2 * uv.scaleY + uv.offsetY);
        const triangles: Triangle[] = [];
        for (const polygon of polygons) {
            for (const [pa, pb, pc] of this.triangulatePolygon(polygon)) {
                const at = (p: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(p.x, y, p.y);
                triangles.push(new Triangle(at(pa, topY), at(pb, topY), at(pc, topY), uvFor(pa), uvFor(pb), uvFor(pc)));
                triangles.push(new Triangle(at(pa, bottomY), at(pc, bottomY), at(pb, bottomY), uvFor(pa), uvFor(pc), uvFor(pb)));
            }
        }
        // The fascia closing the slab's outer (and any inner-hole) edges is the exact same
        // vertical box-strip operation the walls already use - just spanning from the
        // underside up to the top surface instead of from the ground up.
        triangles.push(...this.buildWallStrip(edges, bottomY, thickness, uv, false, [], []));
        return triangles;
    }

    // A solid parapet wall around a flat roof's edge: an outer face, an inner face (facing
    // back toward the roof), and a top cap - a real 3D "murek", not the single infinitely-
    // thin plane the ordinary walls use (a parapet is looked at edge-on far more often than
    // a wall is, so its lack of thickness was much more noticeable).
    private buildParapetStrip(edges: WallEdge[], baseY: number, height: number, thickness: number, uv: UVTransform): Triangle[] {
        if (edges.length === 0 || height <= 0) return [];
        const centroid = this.computeEdgeCentroid(edges);
        const triangles: Triangle[] = [];
        const uvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * uv.scaleX + uv.offsetX, v * uv.scaleY + uv.offsetY);
        const addQuad = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, uWidth: number, vHeight: number): void => {
            triangles.push(new Triangle(p0, p1, p2, uvFor(0, 0), uvFor(uWidth, 0), uvFor(uWidth, vHeight)));
            triangles.push(new Triangle(p0, p2, p3, uvFor(0, 0), uvFor(uWidth, vHeight), uvFor(0, vHeight)));
        };

        for (const edge of edges) {
            let a2 = edge.a;
            let b2 = edge.b;
            const rawDir = new THREE.Vector3(b2[0] - a2[0], 0, b2[1] - a2[1]);
            const length = rawDir.length();
            if (length < 1e-4) continue;
            const rawFaceNormal = new THREE.Vector3(-rawDir.z, 0, rawDir.x).normalize();
            const mid = new THREE.Vector3((a2[0] + b2[0]) / 2, 0, (a2[1] + b2[1]) / 2);
            if (rawFaceNormal.dot(mid.clone().sub(centroid)) < 0) {
                [a2, b2] = [b2, a2];
            }
            // Recomputed from the (possibly just-swapped) a2/b2, not the pre-swap dir above -
            // reusing the stale direction here was the actual bug: outward matched the
            // original edge order even on edges the swap just reversed, so the offset below
            // pointed out of the building instead of in for exactly those edges.
            const dir = new THREE.Vector3(b2[0] - a2[0], 0, b2[1] - a2[1]).normalize();
            const outward = new THREE.Vector3(-dir.z, 0, dir.x);
            const inwardOffset = outward.clone().multiplyScalar(-Math.max(0.02, thickness));

            const outerA = new THREE.Vector3(a2[0], baseY, a2[1]);
            const outerB = new THREE.Vector3(b2[0], baseY, b2[1]);
            const outerA2 = outerA.clone().setY(baseY + height);
            const outerB2 = outerB.clone().setY(baseY + height);
            const innerA = outerA.clone().add(inwardOffset);
            const innerB = outerB.clone().add(inwardOffset);
            const innerA2 = innerA.clone().setY(baseY + height);
            const innerB2 = innerB.clone().setY(baseY + height);

            addQuad(outerA, outerB, outerB2, outerA2, length, height);
            addQuad(innerB, innerA, innerA2, innerB2, length, height);
            addQuad(outerA2, outerB2, innerB2, innerA2, length, thickness);
        }
        return triangles;
    }

    // Every segment gets its own complete gable roof, sized to that segment's own rectangle
    // and built from that segment's own wall height, ridge height and overhang - see the
    // class-level note on SegmentEntry for why this is always per-segment rather than a
    // shared merged roof (a merged roof drifted out of alignment with the real walls
    // whenever segments differed in size). Where two segments' roof volumes overlap, they
    // simply interpenetrate rather than forming a true architectural valley - real
    // hip/valley intersection is a straight-skeleton problem well beyond what a level
    // editor's prop building needs.
    private buildGableRoofForRect(
        cx: number,
        cz: number,
        rectWidth: number,
        rectDepth: number,
        baseY: number,
        ridgeHeight: number,
        overhang: number,
        ridgeAlongX: boolean,
        gableWallsOut: Triangle[],
        windowsOut: Triangle[],
        doorsOut: Triangle[],
    ): Triangle[] {
        overhang = Math.max(0, overhang);
        // wallHalf* is the real wall footprint (what the gable end wall sits at) - padded by
        // the same amount computeFootprintPolygons pads every segment before the wall union,
        // so the gable end wall's corners land exactly on the real (padded) exterior wall
        // instead of sitting just inside it. half* adds the overhang on top of that and is
        // only for the roof panels themselves - keeping the wall recessed behind the
        // overhanging roof is what makes the eave read as a real 3D ledge instead of the wall
        // sitting flush with the roof's outer edge with nothing underneath it.
        const wallHalfWidth = Math.max(MIN_SEGMENT_SIZE, rectWidth) / 2 + FOOTPRINT_UNION_PADDING;
        const wallHalfDepth = Math.max(MIN_SEGMENT_SIZE, rectDepth) / 2 + FOOTPRINT_UNION_PADDING;
        const halfWidth = wallHalfWidth + overhang;
        const halfDepth = wallHalfDepth + overhang;
        const ridgeY = baseY + Math.max(0.1, ridgeHeight);
        const thickness = Math.max(0.02, this.roofThickness);

        const uv = this.roofUV;
        const gableUv = this.gableWallUV;
        const uvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * uv.scaleX + uv.offsetX, v * uv.scaleY + uv.offsetY);
        const gableUvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * gableUv.scaleX + gableUv.offsetX, v * gableUv.scaleY + gableUv.offsetY);
        const triangles: Triangle[] = [];

        // Extrudes one already-correctly-wound sloped quad into a real slab: the given top
        // face, a bottom face offset along the panel's own normal (so the slab keeps
        // uniform thickness across the slope rather than a fixed vertical offset), and
        // fascia strips closing all four sides - this is what gives the overhang real 3D
        // depth instead of an infinitely thin plane with the sky visible underneath it. UV
        // is scaled from real edge lengths, not a fixed 0..1 span, so a texture tiles at a
        // consistent texel-per-metre rate instead of stretching across whatever the panel's
        // actual size happens to be (very visible on the thin fascia strips in particular).
        const addThickPanel = (corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]): void => {
            const normal = corners[1].clone().sub(corners[0]).cross(corners[2].clone().sub(corners[0])).normalize();
            const offset = normal.multiplyScalar(-thickness);
            const bottom = corners.map((c) => c.clone().add(offset)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
            const widthDist = corners[0].distanceTo(corners[1]);
            const heightDist = corners[0].distanceTo(corners[3]);
            triangles.push(new Triangle(corners[0], corners[1], corners[2], uvFor(0, 0), uvFor(widthDist, 0), uvFor(widthDist, heightDist)));
            triangles.push(new Triangle(corners[0], corners[2], corners[3], uvFor(0, 0), uvFor(widthDist, heightDist), uvFor(0, heightDist)));
            triangles.push(new Triangle(bottom[2], bottom[1], bottom[0], uvFor(widthDist, heightDist), uvFor(widthDist, 0), uvFor(0, 0)));
            triangles.push(new Triangle(bottom[3], bottom[2], bottom[0], uvFor(0, heightDist), uvFor(widthDist, heightDist), uvFor(0, 0)));
            for (let i = 0; i < 4; i++) {
                const j = (i + 1) % 4;
                const edgeLength = corners[i].distanceTo(corners[j]);
                triangles.push(new Triangle(corners[j], corners[i], bottom[i], uvFor(0, 0), uvFor(edgeLength, 0), uvFor(edgeLength, thickness)));
                triangles.push(new Triangle(corners[j], bottom[i], bottom[j], uvFor(0, 0), uvFor(edgeLength, thickness), uvFor(0, thickness)));
            }
        };

        // The triangular "attic wall" filling the gap between the flat wall-top and the two
        // roof slopes - its own geometry group (not part of 'roof'), recessed to the real
        // wall footprint (see wallHalfWidth/wallHalfDepth above) rather than sitting out at
        // the overhanging roof edge, and cuttable the same way a normal wall is: any
        // opening whose node projects onto this triangle's base line (and whose height
        // falls between the wall-top and the ridge) gets a hole, clamped so it never pokes
        // through the sloped sides, plus the usual 3D pane/reveal insert.
        //
        // p0/p1/p2 may carry the apex in any position (the two branches below build this
        // triangle with the ridge point in different argument slots, each already verified
        // to wind outward for THAT specific order) - re-deriving (a, b, apex) via a cyclic
        // rotation rather than a fixed slot always reconstructs the exact same winding
        // (rotating a triangle's vertex order never flips its normal; only swapping two
        // vertices does), so this stays correct regardless of which slot the caller used.
        const addGableWall = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3): void => {
            let a: THREE.Vector3;
            let b: THREE.Vector3;
            let apex: THREE.Vector3;
            if (Math.abs(p0.y - baseY) > 0.01) { apex = p0; a = p1; b = p2; }
            else if (Math.abs(p1.y - baseY) > 0.01) { apex = p1; a = p2; b = p0; }
            else { apex = p2; a = p0; b = p1; }

            const tangent = b.clone().sub(a);
            const width = tangent.length();
            if (width < 1e-4) return;
            const outward = tangent.clone().cross(apex.clone().sub(a)).normalize();
            tangent.normalize();
            const point3 = (u: number, v: number): THREE.Vector3 => new THREE.Vector3(a.x + tangent.x * u, a.y + v, a.z + tangent.z * u);
            const apexU = apex.clone().sub(a).dot(tangent);
            const apexV = apex.y - a.y;

            const openings = this.collectOpeningsForEdge([a.x, a.z], [b.x, b.z], baseY, ridgeY);
            const holes: THREE.Vector2[][] = [];
            for (const opening of openings) {
                const halfW = opening.width / 2;
                const u0 = THREE.MathUtils.clamp(opening.u - halfW, WALL_SNAP_MARGIN, width - WALL_SNAP_MARGIN);
                const u1 = THREE.MathUtils.clamp(opening.u + halfW, WALL_SNAP_MARGIN, width - WALL_SNAP_MARGIN);
                if (u1 - u0 < 0.1) continue;
                const limitAt = (u: number): number => (u <= apexU
                    ? apexV * (u / Math.max(1e-4, apexU))
                    : apexV * ((width - u) / Math.max(1e-4, width - apexU)));
                const limit = Math.min(limitAt(u0), limitAt(u1)) - 0.1;
                if (limit <= 0.15) continue;
                const v0 = THREE.MathUtils.clamp(opening.sill, 0.02, limit - 0.1);
                const v1 = Math.min(opening.sill + opening.height, limit);
                if (v1 - v0 < 0.1) continue;
                holes.push([new THREE.Vector2(u0, v0), new THREE.Vector2(u1, v0), new THREE.Vector2(u1, v1), new THREE.Vector2(u0, v1)]);
                this.appendOpeningInsert(
                    opening.type === 'door' ? doorsOut : windowsOut,
                    gableWallsOut,
                    point3, outward, u0, v0, u1, v1, opening.depth,
                    opening.type === 'door' ? this.doorUV : this.windowUV,
                    gableUv,
                );
            }

            if (holes.length === 0) {
                gableWallsOut.push(new Triangle(a, b, apex, gableUvFor(0, 0), gableUvFor(width, 0), gableUvFor(apexU, apexV)));
                return;
            }

            const contour = [new THREE.Vector2(0, 0), new THREE.Vector2(width, 0), new THREE.Vector2(apexU, apexV)];
            const indices = THREE.ShapeUtils.triangulateShape(contour, holes);
            const points = [...contour, ...holes.flat()];
            for (const [ia, ib, ic] of indices) {
                const pa = points[ia];
                const pb = points[ib];
                const pc = points[ic];
                gableWallsOut.push(new Triangle(
                    point3(pa.x, pa.y), point3(pb.x, pb.y), point3(pc.x, pc.y),
                    gableUvFor(pa.x, pa.y), gableUvFor(pb.x, pb.y), gableUvFor(pc.x, pc.y),
                ));
            }
        };

        // See buildGableRoof's own note on the ridgeAlongX/ridgeAlongZ handedness flip:
        // each branch's point order below is individually verified outward-facing, not
        // mirrored from the other.
        if (ridgeAlongX) {
            const eaveNear = [new THREE.Vector3(cx - halfWidth, baseY, cz - halfDepth), new THREE.Vector3(cx + halfWidth, baseY, cz - halfDepth)];
            const eaveFar = [new THREE.Vector3(cx + halfWidth, baseY, cz + halfDepth), new THREE.Vector3(cx - halfWidth, baseY, cz + halfDepth)];
            const ridgeNear = new THREE.Vector3(cx - halfWidth, ridgeY, cz);
            const ridgeFar = new THREE.Vector3(cx + halfWidth, ridgeY, cz);
            addThickPanel([ridgeNear, ridgeFar, eaveNear[1], eaveNear[0]]);
            addThickPanel([ridgeFar, ridgeNear, eaveFar[1], eaveFar[0]]);
            addGableWall(
                new THREE.Vector3(cx - wallHalfWidth, baseY, cz - wallHalfDepth),
                new THREE.Vector3(cx - wallHalfWidth, baseY, cz + wallHalfDepth),
                new THREE.Vector3(cx - wallHalfWidth, ridgeY, cz),
            );
            addGableWall(
                new THREE.Vector3(cx + wallHalfWidth, baseY, cz - wallHalfDepth),
                new THREE.Vector3(cx + wallHalfWidth, ridgeY, cz),
                new THREE.Vector3(cx + wallHalfWidth, baseY, cz + wallHalfDepth),
            );
        } else {
            const eaveNear = [new THREE.Vector3(cx - halfWidth, baseY, cz - halfDepth), new THREE.Vector3(cx - halfWidth, baseY, cz + halfDepth)];
            const eaveFar = [new THREE.Vector3(cx + halfWidth, baseY, cz + halfDepth), new THREE.Vector3(cx + halfWidth, baseY, cz - halfDepth)];
            const ridgeNear = new THREE.Vector3(cx, ridgeY, cz - halfDepth);
            const ridgeFar = new THREE.Vector3(cx, ridgeY, cz + halfDepth);
            addThickPanel([eaveNear[0], eaveNear[1], ridgeFar, ridgeNear]);
            addThickPanel([eaveFar[0], eaveFar[1], ridgeNear, ridgeFar]);
            addGableWall(
                new THREE.Vector3(cx - wallHalfWidth, baseY, cz - wallHalfDepth),
                new THREE.Vector3(cx, ridgeY, cz - wallHalfDepth),
                new THREE.Vector3(cx + wallHalfWidth, baseY, cz - wallHalfDepth),
            );
            addGableWall(
                new THREE.Vector3(cx - wallHalfWidth, baseY, cz + wallHalfDepth),
                new THREE.Vector3(cx + wallHalfWidth, baseY, cz + wallHalfDepth),
                new THREE.Vector3(cx, ridgeY, cz + wallHalfDepth),
            );
        }

        return triangles;
    }

    // --- serialization -------------------------------------------------------------

    public override serialize(id: number): ElementData {
        const { textures, textureRotations } = this.collectTextureMaps();
        const anchor = this.getAnchor();
        return {
            type: 'building',
            id,
            nodes: [{ x: anchor.x, y: anchor.y, z: anchor.z }],
            textures,
            textureRotations,
            uvTransforms: {
                walls: { ...this.wallUV },
                roof: { ...this.roofUV },
                railing: { ...this.railingUV },
                gableWalls: { ...this.gableWallUV },
                windows: { ...this.windowUV },
                doors: { ...this.doorUV },
            },
            buildingSegments: this.segments.map((segment) => ({
                x: segment.node.mesh.position.x,
                y: segment.node.mesh.position.y,
                z: segment.node.mesh.position.z,
                width: segment.width,
                depth: segment.depth,
                wallHeight: segment.wallHeight,
                roofRidgeHeight: segment.roofRidgeHeight,
                roofOverhang: segment.roofOverhang,
                roofDirection: segment.roofDirection,
            })),
            buildingRoofType: this.roofType,
            buildingRoofThickness: this.roofThickness,
            buildingRailingHeight: this.railingHeight,
            buildingRailingThickness: this.railingThickness,
            buildingCutInGround: this.cutInGround,
            buildingOpenings: this.openings.map((opening) => ({
                x: opening.node.mesh.position.x,
                y: opening.node.mesh.position.y,
                z: opening.node.mesh.position.z,
                type: opening.type,
                width: opening.width,
                height: opening.height,
                depth: opening.depth,
            })),
        };
    }

    public static deserialize(data: ElementData): Building {
        const anchorData = data.nodes[0] ?? { x: 0, y: 0, z: 0 };
        const anchor = new THREE.Vector3(anchorData.x, anchorData.y, anchorData.z);
        const segmentsData = (data.buildingSegments && data.buildingSegments.length > 0)
            ? data.buildingSegments
            : [{ x: anchor.x, y: anchor.y, z: anchor.z, width: 8, depth: 6 }];

        // Legacy saves stored wall/ridge/overhang once for the whole building rather than
        // per segment - fall back to those values (or the same defaults used for a brand
        // new segment) when a segment entry doesn't carry its own.
        const legacyWallHeight = data.buildingWallHeight ?? DEFAULT_WALL_HEIGHT;
        const legacyRidgeHeight = data.buildingRoofRidgeHeight ?? DEFAULT_ROOF_RIDGE_HEIGHT;
        const legacyOverhang = data.buildingRoofOverhang ?? DEFAULT_ROOF_OVERHANG;
        const parseDirection = (value: string | undefined): RoofDirection => (value === 'x' || value === 'z' ? value : 'auto');

        const building = new Building(anchor, {
            width: segmentsData[0].width,
            depth: segmentsData[0].depth,
            wallHeight: segmentsData[0].wallHeight ?? legacyWallHeight,
            roofRidgeHeight: segmentsData[0].roofRidgeHeight ?? legacyRidgeHeight,
            roofOverhang: segmentsData[0].roofOverhang ?? legacyOverhang,
            roofDirection: parseDirection(segmentsData[0].roofDirection),
        });
        building.getSegmentNode(0).mesh.position.set(segmentsData[0].x, segmentsData[0].y, segmentsData[0].z);
        for (const segment of segmentsData.slice(1)) {
            building.addSegment(new THREE.Vector3(segment.x, segment.y, segment.z), segment.width, segment.depth, {
                wallHeight: segment.wallHeight ?? legacyWallHeight,
                roofRidgeHeight: segment.roofRidgeHeight ?? legacyRidgeHeight,
                roofOverhang: segment.roofOverhang ?? legacyOverhang,
                roofDirection: parseDirection(segment.roofDirection),
            });
        }

        building.roofType = data.buildingRoofType === 'gable' ? 'gable' : 'flat';
        building.roofThickness = Math.max(0.02, data.buildingRoofThickness ?? 0.15);
        building.railingHeight = Math.max(0.1, data.buildingRailingHeight ?? 1);
        building.railingThickness = Math.max(0.02, data.buildingRailingThickness ?? 0.15);
        building.cutInGround = data.buildingCutInGround ?? false;

        for (const opening of data.buildingOpenings ?? []) {
            const type = opening.type === 'door' ? 'door' : 'window';
            building.addOpening(new THREE.Vector3(opening.x, opening.y, opening.z), type);
            const entry = building.openings[building.openings.length - 1];
            entry.width = Math.max(0.2, opening.width);
            entry.height = Math.max(0.2, opening.height);
            entry.depth = Math.max(0.02, opening.depth ?? 0.1);
        }

        const uv = data.uvTransforms;
        if (uv?.walls) building.wallUV = { ...uv.walls };
        if (uv?.roof) building.roofUV = { ...uv.roof };
        if (uv?.railing) building.railingUV = { ...uv.railing };
        if (uv?.gableWalls) building.gableWallUV = { ...uv.gableWalls };
        if (uv?.windows) building.windowUV = { ...uv.windows };
        if (uv?.doors) building.doorUV = { ...uv.doors };
        building.update();
        return building;
    }

    public override getProperties(): PropertyDefinition {
        const self = this;
        const uvSizeProperty = (label: string, uv: UVTransform, apply: (uv: UVTransform) => void): SectionItem => ({
            type: 'number',
            label,
            get: () => uv.scaleX,
            set: (value: number) => {
                const size = THREE.MathUtils.clamp(value, 0.05, 50);
                apply({ ...uv, scaleX: size, scaleY: size });
                self.update();
            },
            min: 0.05,
            max: 50,
            step: 0.05,
        });

        const sections: { label: string; properties: SectionItem[] }[] = [
            {
                label: 'Transform',
                properties: [{
                    type: 'vector3',
                    label: 'Anchor',
                    get: () => self.getAnchor().clone(),
                    set: (value: THREE.Vector3) => { self.getAnchor().copy(value); self.update(); },
                }],
            },
            {
                label: 'Structure',
                properties: [
                    {
                        type: 'boolean',
                        label: 'Cut Ground',
                        get: () => self.cutInGround,
                        set: (value: boolean) => { self.cutInGround = value; self.update(); },
                    },
                    {
                        type: 'select',
                        label: 'Roof',
                        options: [{ label: 'Flat (Railing)', value: 'flat' }, { label: 'Gable (Triangular)', value: 'gable' }],
                        get: () => self.roofType,
                        set: (value: string) => { self.roofType = value === 'gable' ? 'gable' : 'flat'; self.update(); self.onPropertiesChanged?.(); },
                    },
                    {
                        type: 'number',
                        label: 'Roof Thickness',
                        get: () => self.roofThickness,
                        set: (value: number) => { self.roofThickness = Math.max(0.02, value); self.update(); },
                        min: 0.02,
                        max: 1,
                        step: 0.01,
                    },
                    ...(self.roofType === 'flat' ? [
                        {
                            type: 'number' as const,
                            label: 'Railing Height',
                            get: () => self.railingHeight,
                            set: (value: number) => { self.railingHeight = Math.max(0.1, value); self.update(); },
                            min: 0.1,
                            max: 3,
                            step: 0.05,
                        },
                        {
                            type: 'number' as const,
                            label: 'Railing Thickness',
                            get: () => self.railingThickness,
                            set: (value: number) => { self.railingThickness = Math.max(0.02, value); self.update(); },
                            min: 0.02,
                            max: 1,
                            step: 0.01,
                        },
                    ] : []),
                ],
            },
            {
                label: 'Textures',
                properties: [
                    uvSizeProperty('Wall UV Size', self.wallUV, (uv) => { self.wallUV = uv; }),
                    uvSizeProperty('Roof UV Size', self.roofUV, (uv) => { self.roofUV = uv; }),
                    self.roofType === 'flat'
                        ? uvSizeProperty('Railing UV Size', self.railingUV, (uv) => { self.railingUV = uv; })
                        : uvSizeProperty('Gable Wall UV Size', self.gableWallUV, (uv) => { self.gableWallUV = uv; }),
                    uvSizeProperty('Window UV Size', self.windowUV, (uv) => { self.windowUV = uv; }),
                    uvSizeProperty('Door UV Size', self.doorUV, (uv) => { self.doorUV = uv; }),
                ],
            },
        ];

        this.segments.forEach((segment, index) => {
            sections.push({
                label: `Segment ${index + 1}`,
                properties: [
                    { type: 'vector3', label: 'Position', get: () => segment.node.mesh.position.clone(), set: (v: THREE.Vector3) => { segment.node.update(v); self.update(); } },
                    { type: 'number', label: 'Width', get: () => segment.width, set: (v: number) => { segment.width = Math.max(MIN_SEGMENT_SIZE, v); self.update(); }, min: MIN_SEGMENT_SIZE, step: 0.1 },
                    { type: 'number', label: 'Depth', get: () => segment.depth, set: (v: number) => { segment.depth = Math.max(MIN_SEGMENT_SIZE, v); self.update(); }, min: MIN_SEGMENT_SIZE, step: 0.1 },
                    {
                        type: 'number',
                        label: 'Wall Height',
                        get: () => segment.wallHeight,
                        set: (v: number) => { segment.wallHeight = Math.max(0.5, v); self.update(); },
                        min: 0.5,
                        max: 20,
                        step: 0.1,
                    },
                    ...(self.roofType === 'gable' ? [
                        {
                            type: 'number' as const,
                            label: 'Roof Ridge Height',
                            get: () => segment.roofRidgeHeight,
                            set: (v: number) => { segment.roofRidgeHeight = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            max: 10,
                            step: 0.05,
                        },
                        {
                            type: 'number' as const,
                            label: 'Roof Overhang',
                            get: () => segment.roofOverhang,
                            set: (v: number) => { segment.roofOverhang = Math.max(0, v); self.update(); },
                            min: 0,
                            max: 5,
                            step: 0.05,
                        },
                        {
                            type: 'select' as const,
                            label: 'Roof Direction',
                            options: [
                                { label: 'Auto', value: 'auto' },
                                { label: 'Along Width (X)', value: 'x' },
                                { label: 'Along Depth (Z)', value: 'z' },
                            ],
                            get: () => segment.roofDirection,
                            set: (v: string) => { segment.roofDirection = v === 'x' || v === 'z' ? v : 'auto'; self.update(); },
                        },
                    ] : []),
                    ...(self.segments.length > 1 ? [{ type: 'button' as const, label: 'Remove Segment', onClick: () => self.removeSegment(index) }] : []),
                ],
            });
        });

        this.openings.forEach((opening, index) => {
            sections.push({
                label: `${opening.type === 'door' ? 'Door' : 'Window'} ${index + 1}`,
                properties: [
                    { type: 'vector3', label: 'Position', get: () => opening.node.mesh.position.clone(), set: (v: THREE.Vector3) => { opening.node.update(v); self.update(); } },
                    { type: 'number', label: 'Width', get: () => opening.width, set: (v: number) => { opening.width = Math.max(0.2, v); self.update(); }, min: 0.2, step: 0.05 },
                    { type: 'number', label: 'Height', get: () => opening.height, set: (v: number) => { opening.height = Math.max(0.2, v); self.update(); }, min: 0.2, step: 0.05 },
                    {
                        type: 'number',
                        label: 'Sill Height',
                        // Derived from the node's own Y (relative to the building's base),
                        // never a separate field - see the class-level note on why.
                        get: () => opening.node.mesh.position.y - self.getAnchor().y,
                        set: (v: number) => {
                            const position = opening.node.mesh.position.clone();
                            position.y = self.getAnchor().y + Math.max(0, v);
                            opening.node.update(position);
                            self.update();
                        },
                        min: 0,
                        step: 0.05,
                    },
                    { type: 'number', label: 'Depth', get: () => opening.depth, set: (v: number) => { opening.depth = Math.max(0.02, v); self.update(); }, min: 0.02, max: 1, step: 0.01 },
                    { type: 'button', label: 'Remove', onClick: () => self.removeOpening(index) },
                ],
            });
        });

        return { title: 'Building', icon: '&#127968;', sections };
    }
}
