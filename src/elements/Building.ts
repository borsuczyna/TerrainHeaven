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
    depth: number;
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
// opening, in the same order as `openings`. An opening's sill height is never stored
// separately from its node's Y - see collectOpeningsForEdge - so dragging it up/down (via
// the gizmo or the Properties panel's Position field) always moves the cut hole; a stored,
// independent sill value previously went stale the moment the node moved.
export default class Building extends WorldElement {
    public wallHeight = 3;
    public roofType: RoofType = 'flat';
    public roofOverhang = 0.4;
    public roofRidgeHeight = 1.6;
    public roofThickness = 0.15;
    public railingHeight = 1;
    // Off by default: a building sitting on top of a rectangular Terrain tile used to
    // always punch a hole under itself with no way to opt out, which is wrong for e.g. a
    // building meant to float above a slope or sit on an existing platform.
    public cutInGround = false;

    private segments: BuildingSegment[];
    private openings: OpeningState[] = [];
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

    public override cutsTerrainSurface(): boolean {
        return this.cutInGround;
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
            ? { type, width: 0.9, height: 2.05, depth: 0.1 }
            : { type, width: 1.2, height: 1.2, depth: 0.1 });
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

    protected override getGeometry(): GeometryGroup[] {
        const polygons = this.computeFootprintPolygons();
        const edges = this.collectWallEdges(polygons);
        const anchor = this.getAnchor();

        const windows: Triangle[] = [];
        const doors: Triangle[] = [];
        const walls = this.buildWallStrip(edges, anchor.y, this.wallHeight, this.wallUV, true, windows, doors);
        const groups: GeometryGroup[] = [{ name: 'walls', triangles: walls }];

        if (this.roofType === 'flat') {
            groups.push({ name: 'roof', triangles: this.buildFlatRoofSlab(polygons, edges, anchor.y + this.wallHeight) });
            groups.push({
                name: 'railing',
                triangles: this.buildWallStrip(edges, anchor.y + this.wallHeight, Math.max(0.1, this.railingHeight), this.railingUV, false, [], []),
            });
            groups.push({ name: 'gableWalls', triangles: [] });
        } else {
            const gableWalls: Triangle[] = [];
            groups.push({ name: 'roof', triangles: this.buildGableRoof(polygons, anchor.y + this.wallHeight, gableWalls) });
            groups.push({ name: 'railing', triangles: [] });
            groups.push({ name: 'gableWalls', triangles: gableWalls });
        }

        groups.push({ name: 'windows', triangles: windows });
        groups.push({ name: 'doors', triangles: doors });

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

    // --- walls / railing (shared box-strip extrusion) -------------------------------

    // Builds a vertical strip of quads (optionally with rectangular holes cut in, for
    // window/door openings) along a set of world-space edges. Used for both the main walls
    // and the flat-roof railing - geometrically identical operation, just a different base
    // height, strip height, and whether openings apply. windowsOut/doorsOut collect the 3D
    // frame/pane inserts for any opening actually cut (see appendOpeningInsert); pass empty
    // arrays for strips that never carry openings (the railing).
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
            this.appendWallSegment(triangles, a2, b2, baseY, height, uv, withOpenings ? this.collectOpeningsForEdge(a2, b2) : [], windowsOut, doorsOut);
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
                point3, outward, u0, v0, u1, v1, opening.depth,
                opening.type === 'door' ? this.doorUV : this.windowUV,
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
    // or door slab, its own texturable surface) set `depth` back from the wall's outward
    // face, plus reveal strips closing the four sides of the recess so the cut reads as a
    // real frame instead of a hole you can see straight through.
    private appendOpeningInsert(
        out: Triangle[],
        point3: (u: number, v: number) => THREE.Vector3,
        outward: THREE.Vector3,
        u0: number,
        v0: number,
        u1: number,
        v1: number,
        depth: number,
        uv: UVTransform,
    ): void {
        const uvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * uv.scaleX + uv.offsetX, v * uv.scaleY + uv.offsetY);
        const inward = outward.clone().multiplyScalar(-Math.max(0.02, depth));
        const outer = [point3(u0, v0), point3(u1, v0), point3(u1, v1), point3(u0, v1)];
        const inner = outer.map((p) => p.clone().add(inward));

        // Recessed pane - same winding as the outer loop (a pure translation preserves the
        // outward-facing normal), so it faces the same way the wall's own surface does.
        out.push(new Triangle(inner[0], inner[1], inner[2], uvFor(0, 0), uvFor(1, 0), uvFor(1, 1)));
        out.push(new Triangle(inner[0], inner[2], inner[3], uvFor(0, 0), uvFor(1, 1), uvFor(0, 1)));

        for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            out.push(new Triangle(outer[j], outer[i], inner[i], uvFor(0, 0), uvFor(1, 0), uvFor(1, 1)));
            out.push(new Triangle(outer[j], inner[i], inner[j], uvFor(0, 0), uvFor(1, 1), uvFor(0, 1)));
        }
    }

    // Position-based, not id-based: an opening just carries a world-space node, so it is
    // matched against whichever wall it currently sits closest to every time geometry is
    // rebuilt. Moving the opening (or reshaping the segment the wall belongs to) never
    // leaves a stale reference to clean up - the opening simply stops cutting a hole
    // anywhere once it's far enough from every wall. The sill height is read directly from
    // the node's own Y (relative to the building's base) rather than a separately stored
    // field, which is what makes dragging the node up/down actually move the hole.
    private collectOpeningsForEdge(a2: Point2, b2: Point2): WallOpening[] {
        const length = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
        if (length < 1e-4) return [];
        const dx = (b2[0] - a2[0]) / length;
        const dz = (b2[1] - a2[1]) / length;
        const anchorY = this.getAnchor().y;
        const result: WallOpening[] = [];

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
            result.push({
                u: THREE.MathUtils.clamp(t, 0, length),
                width: opening.width,
                height: opening.height,
                sill: pos.y - anchorY,
                depth: opening.depth,
                type: opening.type,
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
        // vertical box-strip operation the walls and railing already use - just spanning
        // from the underside up to the top surface instead of from the ground up.
        triangles.push(...this.buildWallStrip(edges, bottomY, thickness, uv, false, [], []));
        return triangles;
    }

    // A single gable prism spanning the whole footprint's bounding box (plus overhang),
    // ridge along the longer axis. Complex non-convex footprints (an L or T shape) get one
    // roof covering the full bounding rectangle rather than a true hip/valley roof over
    // each wing - a deliberate simplification real hip-roof geometry (a full straight-
    // skeleton solve) isn't worth the complexity for a level editor's prop building.
    private buildGableRoof(polygons: FootprintPolygon[], baseY: number, gableWallsOut: Triangle[]): Triangle[] {
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
        // depth instead of an infinitely thin plane with the sky visible underneath it.
        const addThickPanel = (corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]): void => {
            const normal = corners[1].clone().sub(corners[0]).cross(corners[2].clone().sub(corners[0])).normalize();
            const offset = normal.multiplyScalar(-thickness);
            const bottom = corners.map((c) => c.clone().add(offset)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
            triangles.push(new Triangle(corners[0], corners[1], corners[2], uvFor(0, 0), uvFor(1, 0), uvFor(1, 1)));
            triangles.push(new Triangle(corners[0], corners[2], corners[3], uvFor(0, 0), uvFor(1, 1), uvFor(0, 1)));
            triangles.push(new Triangle(bottom[2], bottom[1], bottom[0], uvFor(1, 1), uvFor(1, 0), uvFor(0, 0)));
            triangles.push(new Triangle(bottom[3], bottom[2], bottom[0], uvFor(0, 1), uvFor(1, 1), uvFor(0, 0)));
            for (let i = 0; i < 4; i++) {
                const j = (i + 1) % 4;
                triangles.push(new Triangle(corners[j], corners[i], bottom[i], uvFor(0, 0), uvFor(1, 0), uvFor(1, 1)));
                triangles.push(new Triangle(corners[j], bottom[i], bottom[j], uvFor(0, 0), uvFor(1, 1), uvFor(0, 1)));
            }
        };

        // The triangular "attic wall" filling the gap between the flat wall-top and the two
        // roof slopes - its own geometry group (not part of 'roof'), so it can carry a
        // different texture than the sloped panels.
        const addGableWall = (a: THREE.Vector3, b: THREE.Vector3, apex: THREE.Vector3): void => {
            gableWallsOut.push(new Triangle(a, b, apex, gableUvFor(0, 0), gableUvFor(1, 0), gableUvFor(0.5, 1)));
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
            addGableWall(eaveNear[0], eaveFar[1], ridgeNear);
            addGableWall(eaveNear[1], ridgeFar, eaveFar[0]);
        } else {
            const eaveNear = [new THREE.Vector3(cx - halfWidth, baseY, cz - halfDepth), new THREE.Vector3(cx - halfWidth, baseY, cz + halfDepth)];
            const eaveFar = [new THREE.Vector3(cx + halfWidth, baseY, cz + halfDepth), new THREE.Vector3(cx + halfWidth, baseY, cz - halfDepth)];
            const ridgeNear = new THREE.Vector3(cx, ridgeY, cz - halfDepth);
            const ridgeFar = new THREE.Vector3(cx, ridgeY, cz + halfDepth);
            addThickPanel([eaveNear[0], eaveNear[1], ridgeFar, ridgeNear]);
            addThickPanel([eaveFar[0], eaveFar[1], ridgeNear, ridgeFar]);
            addGableWall(eaveNear[0], ridgeNear, eaveFar[1]);
            addGableWall(eaveNear[1], eaveFar[0], ridgeFar);
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
            buildingSegments: this.segments.map((segment) => ({ ...segment })),
            buildingWallHeight: this.wallHeight,
            buildingRoofType: this.roofType,
            buildingRoofOverhang: this.roofOverhang,
            buildingRoofRidgeHeight: this.roofRidgeHeight,
            buildingRoofThickness: this.roofThickness,
            buildingRailingHeight: this.railingHeight,
            buildingCutInGround: this.cutInGround,
            buildingOpenings: this.openings.map((opening, index) => {
                const position = this.getOpeningNode(index).mesh.position;
                return { x: position.x, y: position.y, z: position.z, type: opening.type, width: opening.width, height: opening.height, depth: opening.depth };
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
        building.roofThickness = Math.max(0.02, data.buildingRoofThickness ?? 0.15);
        building.railingHeight = Math.max(0.1, data.buildingRailingHeight ?? 1);
        building.cutInGround = data.buildingCutInGround ?? false;

        for (const opening of data.buildingOpenings ?? []) {
            const nodeIndex = building.nodes.length;
            building.setNode(nodeIndex, new WorldNode(new THREE.Vector3(opening.x, opening.y, opening.z), OPENING_NODE_COLOR));
            building.openings.push({
                type: opening.type === 'door' ? 'door' : 'window',
                width: Math.max(0.2, opening.width),
                height: Math.max(0.2, opening.height),
                depth: Math.max(0.02, opening.depth ?? 0.1),
            });
        }

        const uv = data.uvTransforms;
        if (uv?.walls) building.wallUV = { ...uv.walls };
        if (uv?.roof) building.roofUV = { ...uv.roof };
        if (uv?.railing) building.railingUV = { ...uv.railing };
        if (uv?.gableWalls) building.gableWallUV = { ...uv.gableWalls };
        if (uv?.windows) building.windowUV = { ...uv.windows };
        if (uv?.doors) building.doorUV = { ...uv.doors };
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
                        type: 'boolean',
                        label: 'Cut Ground',
                        get: () => self.cutInGround,
                        set: (value: boolean) => { self.cutInGround = value; self.update(); },
                    },
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
                    {
                        type: 'number',
                        label: 'Roof Thickness',
                        get: () => self.roofThickness,
                        set: (value: number) => { self.roofThickness = Math.max(0.02, value); self.update(); },
                        min: 0.02,
                        max: 1,
                        step: 0.01,
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
                    {
                        type: 'number',
                        label: 'Sill Height',
                        // Derived from the node's own Y (relative to the building's base),
                        // never a separate field - see the class-level note on why.
                        get: () => node.mesh.position.y - self.getAnchor().y,
                        set: (v: number) => {
                            const position = node.mesh.position.clone();
                            position.y = self.getAnchor().y + Math.max(0, v);
                            node.update(position);
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
