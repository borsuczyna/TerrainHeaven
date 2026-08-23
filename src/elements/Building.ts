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
    offsetX: number;
    offsetZ: number;
    width: number;
    depth: number;
}

export type RoofType = 'flat' | 'gable';
export type OpeningType = 'window' | 'door';

interface OpeningState {
    type: OpeningType;
    width: number;
    height: number;
    sill: number;
}

interface FootprintPolygon {
    contour: Ring;
    holes: Ring[];
}

interface WallEdge {
    a: Point2;
    b: Point2;
}

const OPENING_NODE_COLOR = 0xffa64d;
const MIN_SEGMENT_SIZE = 1;
const WALL_SNAP_DISTANCE = 0.6;
const WALL_SNAP_MARGIN = 0.3;

// A multi-room building: one or more rectangular footprint segments (unioned via the same
// polygon-clipping approach TerrainMesher uses for touching terrain tiles) extruded into
// walls, with window/door openings cut directly into whichever wall they sit against, and a
// flat-with-railing or gable roof capping it. Node 0 is the building's own anchor (segment
// offsets and every opening position are stored relative to nothing but world space, so
// dragging the whole building or an individual opening both fall out of the ordinary
// multi-node translate path other elements already use - see PolygonTerrain for the same
// pattern and why it matters for GizmoManager's group-drag behaviour). Nodes 1+ are one per
// opening, in the same order as `openings`.
export default class Building extends WorldElement {
    public wallHeight = 3;
    public roofType: RoofType = 'flat';
    public roofOverhang = 0.4;
    public roofRidgeHeight = 1.6;
    public railingHeight = 1;

    private segments: BuildingSegment[];
    private openings: OpeningState[] = [];
    private wallUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    private roofUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    private railingUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

    constructor(anchor: THREE.Vector3, firstSegment: BuildingSegment) {
        super();
        this.mesh.castShadow = true;
        this.setNode(0, new WorldNode(anchor.clone(), Config.editor.nodeColor));
        this.segments = [firstSegment];
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

    private getAnchor(): THREE.Vector3 {
        return this.nodes[0].mesh.position;
    }

    // Read-only world position, for tools computing a new segment/opening's offset from a
    // raycast hit without needing to duplicate the anchor-node lookup.
    public getAnchorPosition(): THREE.Vector3 {
        return this.getAnchor().clone();
    }

    public get segmentCount(): number {
        return this.segments.length;
    }

    public getSegment(index: number): BuildingSegment {
        return this.segments[index];
    }

    public addSegment(segment: BuildingSegment): void {
        this.segments.push(segment);
        this.update();
    }

    public removeSegment(index: number): boolean {
        if (this.segments.length <= 1 || index < 0 || index >= this.segments.length) return false;
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
        return this.nodes[index + 1];
    }

    public getOpeningData(index: number): OpeningState {
        return this.openings[index];
    }

    public addOpening(worldPosition: THREE.Vector3, type: OpeningType): void {
        const nodeIndex = this.nodes.length;
        this.setNode(nodeIndex, new WorldNode(worldPosition.clone(), OPENING_NODE_COLOR));
        this.openings.push(type === 'door'
            ? { type, width: 0.9, height: 2.05, sill: 0 }
            : { type, width: 1.2, height: 1.2, sill: 0.9 });
        this.update();
    }

    public removeOpening(index: number): boolean {
        const nodeIndex = index + 1;
        const node = this.nodes[nodeIndex];
        if (!node) return false;
        this.mesh.remove(node.mesh);
        node.dispose();
        this.nodes.splice(nodeIndex, 1);
        this.openings.splice(index, 1);
        this.update();
        return true;
    }

    public override getNodeBasis(_index: number): NodeBasis {
        return {
            forward: new THREE.Vector3(1, 0, 0),
            right: new THREE.Vector3(0, 0, 1),
            up: new THREE.Vector3(0, 1, 0),
        };
    }

    public override getUVGroups(): string[] {
        return ['walls', 'roof', 'railing'];
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
        else this.railingUV = next;
        this.update();
    }

    private uvMapFor(group: string): UVTransform | null {
        if (group === 'walls') return this.wallUV;
        if (group === 'roof') return this.roofUV;
        if (group === 'railing') return this.railingUV;
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

    protected override getGeometry(): GeometryGroup[] {
        const polygons = this.computeFootprintPolygons();
        const edges = this.collectWallEdges(polygons);
        const anchor = this.getAnchor();

        const walls = this.buildWallStrip(edges, anchor.y, this.wallHeight, this.wallUV, true);
        const groups: GeometryGroup[] = [{ name: 'walls', triangles: walls }];

        if (this.roofType === 'flat') {
            groups.push({ name: 'roof', triangles: this.buildFlatRoofCap(polygons, anchor.y + this.wallHeight) });
            groups.push({
                name: 'railing',
                triangles: this.buildWallStrip(edges, anchor.y + this.wallHeight, Math.max(0.1, this.railingHeight), this.railingUV, false),
            });
        } else {
            groups.push({ name: 'roof', triangles: this.buildGableRoof(polygons, anchor.y + this.wallHeight) });
            groups.push({ name: 'railing', triangles: [] });
        }

        return groups;
    }

    public getExportGeometry(_lodIndex: number): GeometryGroup[] {
        return this.getGeometry();
    }

    // --- footprint -----------------------------------------------------------------

    private computeFootprintPolygons(): FootprintPolygon[] {
        if (this.segments.length === 0) return [];
        const anchor = this.getAnchor();
        const rectRing = (segment: BuildingSegment): Ring => {
            const cx = anchor.x + segment.offsetX;
            const cz = anchor.z + segment.offsetZ;
            const hw = Math.max(MIN_SEGMENT_SIZE, segment.width) / 2;
            const hd = Math.max(MIN_SEGMENT_SIZE, segment.depth) / 2;
            return [[cx - hw, cz - hd], [cx + hw, cz - hd], [cx + hw, cz + hd], [cx - hw, cz + hd]];
        };

        let surface: MultiPolygon = [[rectRing(this.segments[0])]];
        if (this.segments.length > 1) {
            const polys = this.segments.map((segment) => [[rectRing(segment)]] as MultiPolygon);
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

    private triangulatePolygon(polygon: FootprintPolygon): [THREE.Vector2, THREE.Vector2, THREE.Vector2][] {
        const contour = polygon.contour.map(([x, z]) => new THREE.Vector2(x, z));
        const holes = polygon.holes.map((hole) => hole.map(([x, z]) => new THREE.Vector2(x, z)));
        const indices = THREE.ShapeUtils.triangulateShape(contour, holes);
        const points = [...contour, ...holes.flat()];
        return indices.map(([ia, ib, ic]) => [points[ia], points[ib], points[ic]]);
    }

    // --- walls / railing (shared box-strip extrusion) -------------------------------

    // Builds a vertical strip of quads (optionally with rectangular holes cut in, for
    // window/door openings) along a set of world-space edges. Used for both the main walls
    // and the flat-roof railing - geometrically identical operation, just a different base
    // height, strip height, and whether openings apply.
    private buildWallStrip(edges: WallEdge[], baseY: number, height: number, uv: UVTransform, withOpenings: boolean): Triangle[] {
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
            this.appendWallSegment(triangles, a2, b2, baseY, height, uv, withOpenings ? this.collectOpeningsForEdge(a2, b2) : []);
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
        openings: { u: number; width: number; height: number; sill: number }[],
    ): void {
        const dir = new THREE.Vector3(b2[0] - a2[0], 0, b2[1] - a2[1]);
        const length = dir.length();
        dir.normalize();
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

    // Position-based, not id-based: an opening just carries a world-space node, so it is
    // matched against whichever wall it currently sits closest to every time geometry is
    // rebuilt. Moving the opening (or reshaping the segment the wall belongs to) never
    // leaves a stale reference to clean up - the opening simply stops cutting a hole
    // anywhere once it's far enough from every wall.
    private collectOpeningsForEdge(a2: Point2, b2: Point2): { u: number; width: number; height: number; sill: number }[] {
        const length = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
        if (length < 1e-4) return [];
        const dx = (b2[0] - a2[0]) / length;
        const dz = (b2[1] - a2[1]) / length;
        const result: { u: number; width: number; height: number; sill: number }[] = [];

        for (let i = 0; i < this.openings.length; i++) {
            const node = this.nodes[i + 1];
            if (!node) continue;
            const pos = node.mesh.position;
            const relX = pos.x - a2[0];
            const relZ = pos.z - a2[1];
            const t = relX * dx + relZ * dz;
            if (t < -WALL_SNAP_MARGIN || t > length + WALL_SNAP_MARGIN) continue;
            const perp = Math.abs(relX * dz - relZ * dx);
            if (perp > WALL_SNAP_DISTANCE) continue;
            const opening = this.openings[i];
            result.push({ u: THREE.MathUtils.clamp(t, 0, length), width: opening.width, height: opening.height, sill: opening.sill });
        }
        return result;
    }

    // --- roofs -------------------------------------------------------------------

    private buildFlatRoofCap(polygons: FootprintPolygon[], y: number): Triangle[] {
        const uv = this.roofUV;
        const triangles: Triangle[] = [];
        const uvFor = (p: THREE.Vector2): THREE.Vector2 => new THREE.Vector2(p.x * 0.2 * uv.scaleX + uv.offsetX, p.y * 0.2 * uv.scaleY + uv.offsetY);
        for (const polygon of polygons) {
            for (const [pa, pb, pc] of this.triangulatePolygon(polygon)) {
                const at = (p: THREE.Vector2): THREE.Vector3 => new THREE.Vector3(p.x, y, p.y);
                triangles.push(new Triangle(at(pa), at(pb), at(pc), uvFor(pa), uvFor(pb), uvFor(pc)));
            }
        }
        return triangles;
    }

    // A single gable prism spanning the whole footprint's bounding box (plus overhang),
    // ridge along the longer axis. Complex non-convex footprints (an L or T shape) get one
    // roof covering the full bounding rectangle rather than a true hip/valley roof over
    // each wing - a deliberate simplification real hip-roof geometry (a full straight-
    // skeleton solve) isn't worth the complexity for a level editor's prop building.
    private buildGableRoof(polygons: FootprintPolygon[], baseY: number): Triangle[] {
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (const { contour } of polygons) {
            for (const [x, z] of contour) {
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minZ = Math.min(minZ, z);
                maxZ = Math.max(maxZ, z);
            }
        }
        if (!Number.isFinite(minX)) return [];

        const overhang = Math.max(0, this.roofOverhang);
        const cx = (minX + maxX) / 2;
        const cz = (minZ + maxZ) / 2;
        const halfWidth = (maxX - minX) / 2 + overhang;
        const halfDepth = (maxZ - minZ) / 2 + overhang;
        const ridgeY = baseY + Math.max(0.1, this.roofRidgeHeight);
        const ridgeAlongX = maxX - minX >= maxZ - minZ;

        const uv = this.roofUV;
        const uvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * uv.scaleX + uv.offsetX, v * uv.scaleY + uv.offsetY);
        const triangles: Triangle[] = [];
        const addQuad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void => {
            triangles.push(new Triangle(a, b, c, uvFor(0, 0), uvFor(1, 0), uvFor(1, 1)));
            triangles.push(new Triangle(a, c, d, uvFor(0, 0), uvFor(1, 1), uvFor(0, 1)));
        };
        const addTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
            triangles.push(new Triangle(a, b, c, uvFor(0, 0), uvFor(1, 0), uvFor(0.5, 1)));
        };

        // The two branches below are mirror images of each other (ridge along X vs along
        // Z), but swapping which axis is which flips handedness in a right-handed Y-up
        // system - a vertex order that winds outward-facing normals for the slope quads in
        // one branch winds them inward in the other (and vice versa for the gable-end
        // triangles). Each branch below has its quad/triangle argument order individually
        // verified (via the cross-product of its edges) to face outward, rather than
        // mechanically mirrored from the other, which is what produced inside-out roof
        // faces before.
        if (ridgeAlongX) {
            const eaveNear = [new THREE.Vector3(cx - halfWidth, baseY, cz - halfDepth), new THREE.Vector3(cx + halfWidth, baseY, cz - halfDepth)];
            const eaveFar = [new THREE.Vector3(cx + halfWidth, baseY, cz + halfDepth), new THREE.Vector3(cx - halfWidth, baseY, cz + halfDepth)];
            const ridgeNear = new THREE.Vector3(cx - halfWidth, ridgeY, cz);
            const ridgeFar = new THREE.Vector3(cx + halfWidth, ridgeY, cz);
            addQuad(ridgeNear, ridgeFar, eaveNear[1], eaveNear[0]);
            addQuad(ridgeFar, ridgeNear, eaveFar[1], eaveFar[0]);
            addTri(eaveNear[0], eaveFar[1], ridgeNear);
            addTri(eaveNear[1], ridgeFar, eaveFar[0]);
        } else {
            const eaveNear = [new THREE.Vector3(cx - halfWidth, baseY, cz - halfDepth), new THREE.Vector3(cx - halfWidth, baseY, cz + halfDepth)];
            const eaveFar = [new THREE.Vector3(cx + halfWidth, baseY, cz + halfDepth), new THREE.Vector3(cx + halfWidth, baseY, cz - halfDepth)];
            const ridgeNear = new THREE.Vector3(cx, ridgeY, cz - halfDepth);
            const ridgeFar = new THREE.Vector3(cx, ridgeY, cz + halfDepth);
            addQuad(eaveNear[0], eaveNear[1], ridgeFar, ridgeNear);
            addQuad(eaveFar[0], eaveFar[1], ridgeNear, ridgeFar);
            addTri(eaveNear[0], ridgeNear, eaveFar[1]);
            addTri(eaveNear[1], eaveFar[0], ridgeFar);
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
            uvTransforms: { walls: { ...this.wallUV }, roof: { ...this.roofUV }, railing: { ...this.railingUV } },
            buildingSegments: this.segments.map((segment) => ({ ...segment })),
            buildingWallHeight: this.wallHeight,
            buildingRoofType: this.roofType,
            buildingRoofOverhang: this.roofOverhang,
            buildingRoofRidgeHeight: this.roofRidgeHeight,
            buildingRailingHeight: this.railingHeight,
            buildingOpenings: this.openings.map((opening, index) => {
                const position = this.getOpeningNode(index).mesh.position;
                return { x: position.x, y: position.y, z: position.z, type: opening.type, width: opening.width, height: opening.height, sill: opening.sill };
            }),
        };
    }

    public static deserialize(data: ElementData): Building {
        const anchorData = data.nodes[0] ?? { x: 0, y: 0, z: 0 };
        const anchor = new THREE.Vector3(anchorData.x, anchorData.y, anchorData.z);
        const segments = (data.buildingSegments && data.buildingSegments.length > 0)
            ? data.buildingSegments
            : [{ offsetX: 0, offsetZ: 0, width: 8, depth: 6 }];

        const building = new Building(anchor, segments[0]);
        for (const segment of segments.slice(1)) building.segments.push(segment);

        building.wallHeight = Math.max(0.5, data.buildingWallHeight ?? 3);
        building.roofType = data.buildingRoofType === 'gable' ? 'gable' : 'flat';
        building.roofOverhang = Math.max(0, data.buildingRoofOverhang ?? 0.4);
        building.roofRidgeHeight = Math.max(0.1, data.buildingRoofRidgeHeight ?? 1.6);
        building.railingHeight = Math.max(0.1, data.buildingRailingHeight ?? 1);

        for (const opening of data.buildingOpenings ?? []) {
            const nodeIndex = building.nodes.length;
            building.setNode(nodeIndex, new WorldNode(new THREE.Vector3(opening.x, opening.y, opening.z), OPENING_NODE_COLOR));
            building.openings.push({
                type: opening.type === 'door' ? 'door' : 'window',
                width: Math.max(0.2, opening.width),
                height: Math.max(0.2, opening.height),
                sill: Math.max(0, opening.sill),
            });
        }

        const uv = data.uvTransforms;
        if (uv?.walls) building.wallUV = { ...uv.walls };
        if (uv?.roof) building.roofUV = { ...uv.roof };
        if (uv?.railing) building.railingUV = { ...uv.railing };
        return building;
    }

    public override getProperties(): PropertyDefinition {
        const self = this;
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
                        type: 'number',
                        label: 'Wall Height',
                        get: () => self.wallHeight,
                        set: (value: number) => { self.wallHeight = Math.max(0.5, value); self.update(); },
                        min: 0.5,
                        max: 20,
                        step: 0.1,
                    },
                    {
                        type: 'select',
                        label: 'Roof',
                        options: [{ label: 'Flat (Railing)', value: 'flat' }, { label: 'Gable (Triangular)', value: 'gable' }],
                        get: () => self.roofType,
                        set: (value: string) => { self.roofType = value === 'gable' ? 'gable' : 'flat'; self.update(); self.onPropertiesChanged?.(); },
                    },
                    ...(self.roofType === 'flat' ? [{
                        type: 'number' as const,
                        label: 'Railing Height',
                        get: () => self.railingHeight,
                        set: (value: number) => { self.railingHeight = Math.max(0.1, value); self.update(); },
                        min: 0.1,
                        max: 3,
                        step: 0.05,
                    }] : [
                        {
                            type: 'number' as const,
                            label: 'Roof Ridge Height',
                            get: () => self.roofRidgeHeight,
                            set: (value: number) => { self.roofRidgeHeight = Math.max(0.1, value); self.update(); },
                            min: 0.1,
                            max: 10,
                            step: 0.05,
                        },
                        {
                            type: 'number' as const,
                            label: 'Roof Overhang',
                            get: () => self.roofOverhang,
                            set: (value: number) => { self.roofOverhang = Math.max(0, value); self.update(); },
                            min: 0,
                            max: 5,
                            step: 0.05,
                        },
                    ]),
                ],
            },
        ];

        this.segments.forEach((segment, index) => {
            sections.push({
                label: `Segment ${index + 1}`,
                properties: [
                    { type: 'number', label: 'Offset X', get: () => segment.offsetX, set: (v: number) => { segment.offsetX = v; self.update(); }, step: 0.1 },
                    { type: 'number', label: 'Offset Z', get: () => segment.offsetZ, set: (v: number) => { segment.offsetZ = v; self.update(); }, step: 0.1 },
                    { type: 'number', label: 'Width', get: () => segment.width, set: (v: number) => { segment.width = Math.max(MIN_SEGMENT_SIZE, v); self.update(); }, min: MIN_SEGMENT_SIZE, step: 0.1 },
                    { type: 'number', label: 'Depth', get: () => segment.depth, set: (v: number) => { segment.depth = Math.max(MIN_SEGMENT_SIZE, v); self.update(); }, min: MIN_SEGMENT_SIZE, step: 0.1 },
                    ...(self.segments.length > 1 ? [{ type: 'button' as const, label: 'Remove Segment', onClick: () => self.removeSegment(index) }] : []),
                ],
            });
        });

        this.openings.forEach((opening, index) => {
            const node = this.getOpeningNode(index);
            sections.push({
                label: `${opening.type === 'door' ? 'Door' : 'Window'} ${index + 1}`,
                properties: [
                    {
                        type: 'select',
                        label: 'Type',
                        options: [{ label: 'Window', value: 'window' }, { label: 'Door', value: 'door' }],
                        get: () => opening.type,
                        set: (v: string) => { opening.type = v === 'door' ? 'door' : 'window'; self.update(); },
                    },
                    { type: 'vector3', label: 'Position', get: () => node.mesh.position.clone(), set: (v: THREE.Vector3) => { node.update(v); self.update(); } },
                    { type: 'number', label: 'Width', get: () => opening.width, set: (v: number) => { opening.width = Math.max(0.2, v); self.update(); }, min: 0.2, step: 0.05 },
                    { type: 'number', label: 'Height', get: () => opening.height, set: (v: number) => { opening.height = Math.max(0.2, v); self.update(); }, min: 0.2, step: 0.05 },
                    { type: 'number', label: 'Sill Height', get: () => opening.sill, set: (v: number) => { opening.sill = Math.max(0, v); self.update(); }, min: 0, step: 0.05 },
                    { type: 'button', label: 'Remove', onClick: () => self.removeOpening(index) },
                ],
            });
        });

        return { title: 'Building', icon: '&#127968;', sections };
    }
}
