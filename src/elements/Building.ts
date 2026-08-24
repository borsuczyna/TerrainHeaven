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
import type { PropertyDefinition, SectionItem } from '../editor/Properties';
import type { BuildingHandleDescriptor } from '../editor/BuildingHandleManager';

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
    roofType?: RoofType;
    hipRidgeRatio?: number;
    gambrelSegments?: number;
    gambrelRoundness?: number;
    railingEnabled?: boolean;
    railingHeight?: number;
    railingThickness?: number;
}

// Roof type is per-segment, not building-wide, so a building can mix e.g. a gable main
// block with a hip-roofed wing. Flat segments sharing a wall height still merge into one
// slab/parapet (see groupSegmentsByHeight); every pitched type is always built per-segment
// with its own roof, never merged - see buildGableRoofForRect's own note on why.
export type RoofType = 'flat' | 'gable' | 'hip' | 'tented' | 'gambrel';
export type OpeningType = 'window' | 'door';
// Which axis the ridge (or, for hip, the long axis) runs along. 'auto' picks whichever of
// the segment's own width/depth is larger. 'x'/'z' pin it regardless of the segment's
// proportions. Not used for 'flat' or 'tented' (tented has no ridge axis).
export type RoofDirection = 'auto' | 'x' | 'z';

interface SegmentEntry {
    width: number;
    depth: number;
    node: WorldNode;
    wallHeight: number;
    roofRidgeHeight: number;
    roofOverhang: number;
    roofDirection: RoofDirection;
    roofType: RoofType;
    // hip only: how long the ridge line is, as a fraction (0..1) of the standard equal-
    // pitch-on-all-sides length (long half-dimension minus short half-dimension). 0
    // collapses the ridge to a point (same shape as 'tented'); 1 is the standard hip
    // proportions. Not used by 'tented', which always collapses to a point regardless.
    hipRidgeRatio: number;
    // gambrel only: how many slope segments per side (2 = classic barn gambrel break;
    // more reads as a smoother curve) and how much each segment bulges from a straight
    // gable line (0 = plain straight gable subdivided; positive = convex/barn curve;
    // negative = concave/reverse curve).
    gambrelSegments: number;
    gambrelRoundness: number;
    // Flat-roof-only: whether this segment gets a parapet at all, and its own height/
    // thickness - per-segment (not building-wide) so touching flat wings can have
    // different railings, or none. Segments sharing identical height+railing settings
    // (see groupByRailingSettings) still merge into one seamless parapet loop the same
    // way groupSegmentsByHeight merges walls - only segments that actually differ get
    // split apart.
    railingEnabled: boolean;
    railingHeight: number;
    railingThickness: number;
}

interface OpeningEntry {
    type: OpeningType;
    width: number;
    height: number;
    depth: number;
    node: WorldNode;
}

// A gable-roofed dormer window sitting on a sloped roof panel - front wall (with one
// window) facing outward, its own small gable roof running back into the parent roof.
// Only placeable on 'gable' segments for now (see findGableSegmentIndexForPoint). Like
// OpeningEntry, position-based rather than id-based: the node just carries a world-space
// point, and buildRoofWindows re-matches it to the nearest gable segment/slope every
// rebuild rather than storing a segment reference that could go stale.
interface RoofWindowEntry {
    node: WorldNode;
    width: number;
    depth: number;
    wallHeight: number;
    ridgeHeight: number;
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
    // Index into this.openings - lets a cut opening's recessed pane/reveal land in that
    // one opening's own texture group (see the class-level note on per-instance texture
    // groups) instead of a single shared 'windows'/'doors' bucket for the whole building.
    index: number;
    // Overrides the default "windows#<index>"/"doors#<index>" group prefix - used by
    // buildRoofWindows so a dormer's synthetic window doesn't collide with a real
    // building opening that happens to share the same index.
    groupPrefix?: string;
}

const SEGMENT_NODE_COLOR = 0x4da6ff;
const OPENING_NODE_COLOR = 0xffa64d;
const ROOF_WINDOW_NODE_COLOR = 0xc266ff;
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
const DEFAULT_HIP_RIDGE_RATIO = 0.5;
const DEFAULT_GAMBREL_SEGMENTS = 2;
const DEFAULT_GAMBREL_ROUNDNESS = 0.4;
const DEFAULT_RAILING_HEIGHT = 1;
const DEFAULT_RAILING_THICKNESS = 0.15;
const DEFAULT_UV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
const DEFAULT_ROOF_WINDOW_WIDTH = 1.2;
const DEFAULT_ROOF_WINDOW_DEPTH = 1.1;
const DEFAULT_ROOF_WINDOW_WALL_HEIGHT = 1.0;
const DEFAULT_ROOF_WINDOW_RIDGE_HEIGHT = 0.5;
// A dormer is only placed sensibly somewhere between the ridge and the eave - t is the
// fractional perpendicular distance from the ridge (0) to the eave (1) used throughout
// buildRoofWindows; these keep it off both the ridge itself and the very edge of the roof.
const ROOF_WINDOW_MIN_T = 0.12;
const ROOF_WINDOW_MAX_T = 0.94;

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
//
// Texture groups: every wall/roof/gable-wall/railing group is named "<kind>#<segmentIndex>"
// and every window/door pane group "windows#<openingIndex>"/"doors#<openingIndex>" - one
// real material per segment/opening instead of one shared material for the whole building,
// so dropping a texture onto one wall (or one window) doesn't repaint every other one. Wall
// geometry itself still merges seamlessly across touching same-height segments exactly as
// before (see groupSegmentsByHeight) - matchSegmentIndexForEdge/matchSegmentIndexForPoint
// re-attribute each already-merged wall edge or roof triangle back to whichever original
// segment's rectangle it actually lies on, purely for texture-group bucketing, without
// giving up the merge (no interior seam reappears at a shared boundary).
export default class Building extends WorldElement {
    public roofThickness = 0.15;
    // Off by default: a building sitting on top of a rectangular Terrain tile used to
    // always punch a hole under itself with no way to opt out, which is wrong for e.g. a
    // building meant to float above a slope or sit on an existing platform.
    public cutInGround = false;

    private segments: SegmentEntry[];
    // In-viewport resize handles (see BuildingHandleManager) - only exist while the
    // building is selected, torn down and rebuilt from scratch on every geometry update so
    // they never drift out of sync with the segment/roof data they're derived from.
    private handleMeshes: THREE.Mesh[] = [];
    private handlesVisible = false;
    private openings: OpeningEntry[] = [];
    private roofWindows: RoofWindowEntry[] = [];
    // Per-texture-group UV offset/scale, keyed by the same dynamic group names getGeometry()
    // builds ("walls#0", "windows#3", ...) - see the class-level note. Missing entries fall
    // back to DEFAULT_UV, so a segment/opening that's never been customized just uses the
    // identity transform rather than needing to be pre-populated.
    private uvTransforms: Map<string, UVTransform> = new Map();

    constructor(anchor: THREE.Vector3, firstSegment: BuildingSegment) {
        super();
        this.mesh.castShadow = true;
        // No separate "anchor" node: segment 0's own node doubles as the building's height
        // reference (see getAnchor). A dedicated anchor node used to sit here too, but since
        // every segment and opening already carries its own absolute world-space position,
        // dragging the anchor's X/Z did nothing visible - only its Y (read by getAnchor)
        // ever affected anything, which just looked like a second, mostly-inert node
        // sitting right on top of segment 0's real one.
        const segmentNode = new WorldNode(anchor.clone(), SEGMENT_NODE_COLOR);
        this.setNode(0, segmentNode);
        this.segments = [{
            width: Math.max(MIN_SEGMENT_SIZE, firstSegment.width),
            depth: Math.max(MIN_SEGMENT_SIZE, firstSegment.depth),
            node: segmentNode,
            ...Building.normalizeSegmentOptions(firstSegment),
        }];
    }

    // Shared clamping/defaulting for every roof-shape field a segment carries, used by the
    // constructor, addSegment and deserialize alike so a new segment (however it's created)
    // always ends up with the same sane defaults.
    private static normalizeSegmentOptions(options?: {
        wallHeight?: number;
        roofRidgeHeight?: number;
        roofOverhang?: number;
        roofDirection?: RoofDirection;
        roofType?: RoofType;
        hipRidgeRatio?: number;
        gambrelSegments?: number;
        gambrelRoundness?: number;
        railingEnabled?: boolean;
        railingHeight?: number;
        railingThickness?: number;
    }): Omit<SegmentEntry, 'width' | 'depth' | 'node'> {
        return {
            wallHeight: Math.max(0.5, options?.wallHeight ?? DEFAULT_WALL_HEIGHT),
            roofRidgeHeight: Math.max(0.1, options?.roofRidgeHeight ?? DEFAULT_ROOF_RIDGE_HEIGHT),
            roofOverhang: Math.max(0, options?.roofOverhang ?? DEFAULT_ROOF_OVERHANG),
            roofDirection: options?.roofDirection ?? 'auto',
            roofType: options?.roofType ?? 'flat',
            hipRidgeRatio: THREE.MathUtils.clamp(options?.hipRidgeRatio ?? DEFAULT_HIP_RIDGE_RATIO, 0, 1),
            gambrelSegments: Math.max(2, Math.round(options?.gambrelSegments ?? DEFAULT_GAMBREL_SEGMENTS)),
            gambrelRoundness: THREE.MathUtils.clamp(options?.gambrelRoundness ?? DEFAULT_GAMBREL_ROUNDNESS, -0.95, 0.95),
            railingEnabled: options?.railingEnabled ?? true,
            railingHeight: Math.max(0.1, options?.railingHeight ?? DEFAULT_RAILING_HEIGHT),
            railingThickness: Math.max(0.02, options?.railingThickness ?? DEFAULT_RAILING_THICKNESS),
        };
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
        // Handles reposition themselves off the same segment/roof data the geometry above
        // was just rebuilt from, so this has to run after every update() - including the
        // ones a handle's own drag triggers - not just once on selection change.
        this.rebuildHandles();
    }

    public override setSelected(selected: boolean): void {
        super.setSelected(selected);
        this.handlesVisible = selected;
        this.rebuildHandles();
    }

    public override cutsTerrainSurface(): boolean {
        return this.cutInGround;
    }

    private getAnchor(): THREE.Vector3 {
        return this.segments[0].node.mesh.position;
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
        const { node: _node, ...rest } = this.segments[index];
        return rest;
    }

    public getSegmentNode(index: number): WorldNode {
        return this.segments[index].node;
    }

    public addSegment(
        position: THREE.Vector3,
        width: number,
        depth: number,
        options?: Omit<BuildingSegment, 'width' | 'depth'>,
    ): void {
        const node = new WorldNode(position.clone(), SEGMENT_NODE_COLOR);
        this.setNode(this.nodes.length, node);
        this.segments.push({
            width: Math.max(MIN_SEGMENT_SIZE, width),
            depth: Math.max(MIN_SEGMENT_SIZE, depth),
            node,
            ...Building.normalizeSegmentOptions(options),
        });
        this.update();
        this.onPropertiesChanged?.();
    }

    public removeSegment(index: number): boolean {
        if (this.segments.length <= 1 || index < 0 || index >= this.segments.length) return false;
        this.removeTrackedNode(this.segments[index].node);
        this.segments.splice(index, 1);
        this.update();
        this.onPropertiesChanged?.();
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
        this.onPropertiesChanged?.();
    }

    public removeOpening(index: number): boolean {
        const entry = this.openings[index];
        if (!entry) return false;
        this.removeTrackedNode(entry.node);
        this.openings.splice(index, 1);
        this.update();
        this.onPropertiesChanged?.();
        return true;
    }

    public get roofWindowCount(): number {
        return this.roofWindows.length;
    }

    public getRoofWindowNode(index: number): WorldNode {
        return this.roofWindows[index].node;
    }

    public getRoofWindowData(index: number): { width: number; depth: number; wallHeight: number; ridgeHeight: number } {
        const entry = this.roofWindows[index];
        return { width: entry.width, depth: entry.depth, wallHeight: entry.wallHeight, ridgeHeight: entry.ridgeHeight };
    }

    public addRoofWindow(worldPosition: THREE.Vector3): void {
        const node = new WorldNode(worldPosition.clone(), ROOF_WINDOW_NODE_COLOR);
        this.setNode(this.nodes.length, node);
        this.roofWindows.push({
            node,
            width: DEFAULT_ROOF_WINDOW_WIDTH,
            depth: DEFAULT_ROOF_WINDOW_DEPTH,
            wallHeight: DEFAULT_ROOF_WINDOW_WALL_HEIGHT,
            ridgeHeight: DEFAULT_ROOF_WINDOW_RIDGE_HEIGHT,
        });
        this.update();
        this.onPropertiesChanged?.();
    }

    public removeRoofWindow(index: number): boolean {
        const entry = this.roofWindows[index];
        if (!entry) return false;
        this.removeTrackedNode(entry.node);
        this.roofWindows.splice(index, 1);
        this.update();
        this.onPropertiesChanged?.();
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

    // Dynamic: whatever getGeometry() actually built last (segment/opening count and roof
    // types can change from one rebuild to the next) - see the class-level note on why each
    // segment/opening gets its own group name instead of one shared "walls"/"windows"/etc.
    public override getUVGroups(): string[] {
        return this.getGroupNames();
    }

    public override getUVTransform(group: string): UVTransform {
        const current = this.uvTransforms.get(group);
        return current ? { ...current } : super.getUVTransform(group);
    }

    public override setUVTransform(group: string, transform: UVTransform): void {
        this.uvTransforms.set(group, {
            offsetX: Number.isFinite(transform.offsetX) ? transform.offsetX : 0,
            offsetY: Number.isFinite(transform.offsetY) ? transform.offsetY : 0,
            scaleX: Number.isFinite(transform.scaleX) ? Math.max(0.05, transform.scaleX) : 1,
            scaleY: Number.isFinite(transform.scaleY) ? Math.max(0.05, transform.scaleY) : 1,
        });
        this.update();
    }

    private getUVFor(groupName: string): UVTransform {
        return this.uvTransforms.get(groupName) ?? DEFAULT_UV;
    }

    private bucket(map: Map<string, Triangle[]>, key: string): Triangle[] {
        let arr = map.get(key);
        if (!arr) { arr = []; map.set(key, arr); }
        return arr;
    }

    // Attributes an already-merged wall/parapet/fascia edge back to whichever ORIGINAL
    // (pre-union) segment rectangle it lies flush against, purely for texture-group
    // bucketing - the union itself (computeFootprintPolygons) still fully merges touching
    // same-settings segments into one seamless loop; this only decides which segment's
    // material a given surviving boundary edge should render with. candidates is a list of
    // indices into this.segments to consider (usually just the segments that contributed to
    // whichever merged group this edge came from).
    private matchSegmentIndexForEdge(a2: Point2, b2: Point2, candidates: number[]): number {
        const mid: Point2 = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
        const eps = FOOTPRINT_UNION_PADDING + 0.05;
        let best = candidates[0] ?? -1;
        let bestDist = Infinity;
        for (const idx of candidates) {
            const s = this.segments[idx];
            if (!s) continue;
            const cx = s.node.mesh.position.x;
            const cz = s.node.mesh.position.z;
            const hw = Math.max(MIN_SEGMENT_SIZE, s.width) / 2 + FOOTPRINT_UNION_PADDING;
            const hd = Math.max(MIN_SEGMENT_SIZE, s.depth) / 2 + FOOTPRINT_UNION_PADDING;
            if (mid[0] < cx - hw - eps || mid[0] > cx + hw + eps || mid[1] < cz - hd - eps || mid[1] > cz + hd + eps) continue;
            const d = Math.min(
                Math.abs(mid[0] - (cx - hw)), Math.abs(mid[0] - (cx + hw)),
                Math.abs(mid[1] - (cz - hd)), Math.abs(mid[1] - (cz + hd)),
            );
            if (d < bestDist) { bestDist = d; best = idx; }
        }
        return best;
    }

    // Same idea as matchSegmentIndexForEdge but for an area (a flat roof slab's top/bottom
    // triangles) rather than a boundary edge - picks whichever candidate segment's padded
    // rectangle the point falls inside (or is nearest to, as a fallback for slivers the
    // union padding creates right at a shared boundary).
    private matchSegmentIndexForPoint(p: Point2, candidates: number[]): number {
        let best = candidates[0] ?? -1;
        let bestDist = Infinity;
        for (const idx of candidates) {
            const s = this.segments[idx];
            if (!s) continue;
            const cx = s.node.mesh.position.x;
            const cz = s.node.mesh.position.z;
            const hw = Math.max(MIN_SEGMENT_SIZE, s.width) / 2 + FOOTPRINT_UNION_PADDING;
            const hd = Math.max(MIN_SEGMENT_SIZE, s.depth) / 2 + FOOTPRINT_UNION_PADDING;
            const dx = Math.max(0, Math.abs(p[0] - cx) - hw);
            const dz = Math.max(0, Math.abs(p[1] - cz) - hd);
            const d = dx * dx + dz * dz;
            if (d < bestDist) { bestDist = d; best = idx; }
        }
        return best;
    }

    // Only 'gable' segments have a single flat sloped panel per side (hip/tented panels are
    // trapezoids/triangles, gambrel's is a multi-segment profile) - dormers are restricted
    // to those for now, matched the same position-based way openings match a wall: nearest
    // eligible segment's rectangle to the point, not a stored reference.
    private findGableSegmentIndexForPoint(x: number, z: number): number {
        const candidates = this.segments
            .map((segment, index) => ({ segment, index }))
            .filter((entry) => entry.segment.roofType === 'gable')
            .map((entry) => entry.index);
        return this.matchSegmentIndexForPoint([x, z], candidates);
    }

    // Where a gable segment's roof surface sits above (x, z), and the local directions a
    // dormer placed there needs: outward (horizontal, pointing down-slope toward the eave -
    // the direction its front wall/window faces) and along (horizontal, parallel to the
    // ridge - the direction its width runs). t is the point's own fractional distance from
    // ridge (0) to eave (1), clamped to ROOF_WINDOW_MIN_T/MAX_T so a dormer can't be dragged
    // onto the ridge itself or off the edge of the roof; clampedX/clampedZ is (x, z) moved
    // back onto that clamped t so the dormer visually snaps into a valid range instead of
    // just refusing to move further.
    private computeGableRoofPlacement(segment: SegmentEntry, x: number, z: number): {
        clampedX: number;
        clampedZ: number;
        y: number;
        outward: THREE.Vector3;
        along: THREE.Vector3;
    } {
        const cx = segment.node.mesh.position.x;
        const cz = segment.node.mesh.position.z;
        const wallTopY = this.getAnchor().y + segment.wallHeight;
        const ridgeY = wallTopY + Math.max(0.1, segment.roofRidgeHeight);
        const overhang = Math.max(0, segment.roofOverhang);
        const wallHalfWidth = Math.max(MIN_SEGMENT_SIZE, segment.width) / 2 + FOOTPRINT_UNION_PADDING;
        const wallHalfDepth = Math.max(MIN_SEGMENT_SIZE, segment.depth) / 2 + FOOTPRINT_UNION_PADDING;
        const halfWidth = wallHalfWidth + overhang;
        const halfDepth = wallHalfDepth + overhang;
        const ridgeAlongX = segment.roofDirection === 'x' ? true
            : segment.roofDirection === 'z' ? false
            : segment.width >= segment.depth;

        const half = Math.max(0.01, ridgeAlongX ? halfDepth : halfWidth);
        const raw = ridgeAlongX ? z - cz : x - cx;
        const sign = raw >= 0 ? 1 : -1;
        const t = THREE.MathUtils.clamp(Math.abs(raw) / half, ROOF_WINDOW_MIN_T, ROOF_WINDOW_MAX_T);
        const y = ridgeY - t * (ridgeY - wallTopY);
        const offset = sign * t * half;

        if (ridgeAlongX) {
            return {
                clampedX: x, clampedZ: cz + offset, y,
                outward: new THREE.Vector3(0, 0, sign),
                along: new THREE.Vector3(1, 0, 0),
            };
        }
        return {
            clampedX: cx + offset, clampedZ: z, y,
            outward: new THREE.Vector3(sign, 0, 0),
            along: new THREE.Vector3(0, 0, 1),
        };
    }

    // Builds every roof dormer, bucketing straight into the shared walls/roof/windows maps
    // getGeometry() already assembles the final GeometryGroup[] from. A dormer with no
    // nearby gable segment (e.g. its segment's roof type was changed after placement) simply
    // builds nothing - orphaned exactly the way a wall opening far from any wall does.
    private buildRoofWindows(walls: Map<string, Triangle[]>, roof: Map<string, Triangle[]>, windows: Map<string, Triangle[]>): void {
        this.roofWindows.forEach((entry, index) => {
            const pos = entry.node.mesh.position;
            const segIndex = this.findGableSegmentIndexForPoint(pos.x, pos.z);
            if (segIndex < 0) return;
            const segment = this.segments[segIndex];
            const { clampedX, clampedZ, y, outward, along } = this.computeGableRoofPlacement(segment, pos.x, pos.z);

            const wallKey = `dormerWalls#${index}`;
            const roofKey = `dormerRoof#${index}`;
            const wallUv = this.getUVFor(wallKey);
            const roofUv = this.getUVFor(roofKey);

            const frontCenter = new THREE.Vector3(clampedX, y, clampedZ);
            // Matches buildGableRoofForRect's own internal wallHalfWidth/wallHalfDepth
            // formula exactly (see its call below) - the front/cheek walls need the SAME
            // half-extent the gable-end attic triangle's base uses, or the triangle's wider
            // (padded) base overhangs past the wall's narrower corners with nothing filling
            // the gap, which is what the reported hole at the roof/wall seam actually was.
            const wallHalfW = Math.max(MIN_SEGMENT_SIZE, entry.width) / 2 + FOOTPRINT_UNION_PADDING;
            let leftPoint = frontCenter.clone().addScaledVector(along, -wallHalfW);
            let rightPoint = frontCenter.clone().addScaledVector(along, wallHalfW);
            // buildWallStrip/appendWallSegment always derive "outward" from (a2->b2) via a
            // fixed left-hand rule - pick whichever order actually matches this slope's own
            // outward direction rather than assuming along's sign already agrees with it.
            const testDir = rightPoint.clone().sub(leftPoint).normalize();
            const testOutward = new THREE.Vector3(-testDir.z, 0, testDir.x);
            if (testOutward.dot(outward) < 0) [leftPoint, rightPoint] = [rightPoint, leftPoint];

            this.appendWallSegment(
                this.bucket(walls, wallKey), wallUv, windows, new Map(),
                [leftPoint.x, leftPoint.z], [rightPoint.x, rightPoint.z], y, entry.wallHeight,
                [{
                    u: wallHalfW, width: entry.width * 0.6, height: entry.wallHeight * 0.65,
                    sill: entry.wallHeight * 0.18, depth: 0.08, type: 'window', index, groupPrefix: 'dormerWindows',
                }],
            );

            // Two flat side "cheek" walls closing the gap between the front wall and the
            // parent roof surface rising up behind it - without these the dormer's own roof
            // floated above open air on both sides, showing straight through past the
            // window's recessed reveal to the sky beyond. Built as a plain rectangle at
            // constant height rather than tapered to the parent's rising slope: the rear
            // portion simply embeds into the parent roof's own solid thickness, the same
            // interpenetration-over-true-intersection tradeoff the rear gable wall below
            // already makes.
            const rearCenter = frontCenter.clone().addScaledVector(outward, -entry.depth);
            for (const side of [-1, 1] as const) {
                const sideOffset = along.clone().multiplyScalar(side * wallHalfW);
                const frontEdge = frontCenter.clone().add(sideOffset);
                const rearEdge = rearCenter.clone().add(sideOffset);
                let sideA: Point2 = [frontEdge.x, frontEdge.z];
                let sideB: Point2 = [rearEdge.x, rearEdge.z];
                const sideDir = new THREE.Vector3(sideB[0] - sideA[0], 0, sideB[1] - sideA[1]).normalize();
                const sideNormal = new THREE.Vector3(-sideDir.z, 0, sideDir.x);
                const desiredSideOutward = along.clone().multiplyScalar(side);
                if (sideNormal.dot(desiredSideOutward) < 0) [sideA, sideB] = [sideB, sideA];
                this.appendWallSegment(this.bucket(walls, wallKey), wallUv, windows, new Map(), sideA, sideB, y, entry.wallHeight, []);
            }

            // The dormer's own little gable roof is geometrically identical to a segment's
            // roof (an axis-aligned rectangle with a ridge along one axis) - buildGableRoofForRect
            // already builds exactly that, including the front gable-end attic triangle above
            // the wall just built. Its rear gable end lands embedded inside the parent roof's
            // own (higher, since it's closer to the ridge) surface - invisible from outside, so
            // it's left as-is rather than special-cased away (same interpenetration-over-true-
            // intersection tradeoff the rest of this file already makes for overlapping roofs).
            // buildGableRoofForRect's ridgeAlongX=true means "ridge along X" - the dormer's
            // own ridge always runs along the PARENT slope's outward axis (see the class-
            // level note above), which is X exactly when the parent's along axis is Z.
            const dormerRidgeAlongX = along.x === 0;
            const dormerCenter = frontCenter.clone().addScaledVector(outward, -entry.depth / 2);
            const rectWidth = dormerRidgeAlongX ? entry.depth : entry.width;
            const rectDepth = dormerRidgeAlongX ? entry.width : entry.depth;
            this.bucket(roof, roofKey).push(...this.buildGableRoofForRect(
                dormerCenter.x, dormerCenter.z, rectWidth, rectDepth,
                y + entry.wallHeight, entry.ridgeHeight, 0.15, dormerRidgeAlongX,
                this.bucket(walls, wallKey), roofUv, wallUv, windows, new Map(),
            ));
        });
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
    // for flat roofs, one slab loop) with no interior seam. Segments at a different height
    // simply can't share a wall loop (there's no single top height that would fit both), so
    // they fall into their own group and get their own fully independent walls - stepping a
    // single shared wall loop down at the height boundary was tried and produced broken,
    // inconsistent notch geometry, so this deliberately does not attempt that: differently-
    // tall segments always get separate, non-optimized, possibly overlapping wall loops
    // instead of one clever-but-fragile stepped one.
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

    // Same idea, one level further: among a set of flat segments that already share a wall
    // height, sub-group by their own railing settings too - a parapet is one continuous
    // physical strip, so two touching segments can only share one only if their height AND
    // thickness AND enabled state actually match. A segment with railingEnabled=false is
    // expected to already be filtered out by the caller before this runs.
    private groupByRailingSettings(segments: SegmentEntry[]): SegmentEntry[][] {
        const groups = new Map<string, SegmentEntry[]>();
        for (const segment of segments) {
            const key = `${Math.round(segment.railingHeight * 1000)}_${Math.round(segment.railingThickness * 1000)}`;
            const group = groups.get(key);
            if (group) group.push(segment);
            else groups.set(key, [segment]);
        }
        return [...groups.values()];
    }

    // --- viewport resize handles -----------------------------------------------------

    private clearHandles(): void {
        for (const mesh of this.handleMeshes) {
            this.mesh.remove(mesh);
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
        }
        this.handleMeshes = [];
    }

    // pointA/pointB (world-space) are the two ends of the visible line - it doubles as the
    // draggable hit target, so a wall-height handle for instance actually looks like the
    // wall's own height rather than a dot floating at the top of it. axis/sensitivity work
    // the same as before: axis is the world-space direction the value increases in, and
    // sensitivity is how many world units the LINE'S REFERENCE POINT (its midpoint) would
    // move per 1 unit of value change - used only to calibrate the drag, not to move the
    // line directly (rebuildHandles already redraws it from scratch after every change).
    private addHandleLine(
        pointA: THREE.Vector3,
        pointB: THREE.Vector3,
        axis: THREE.Vector3,
        sensitivity: number,
        label: string,
        getValue: () => number,
        setValue: (v: number) => void,
        min?: number,
        max?: number,
    ): void {
        const length = pointA.distanceTo(pointB);
        if (length < 1e-4) return;
        const geometry = new THREE.CylinderGeometry(0.045, 0.045, length, 8);
        const material = new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false, transparent: true, opacity: 0.9 });
        const mesh = new THREE.Mesh(geometry, material);
        const midWorld = pointA.clone().add(pointB).multiplyScalar(0.5);
        mesh.position.copy(this.mesh.worldToLocal(midWorld.clone()));
        const dir = pointB.clone().sub(pointA).normalize();
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        mesh.renderOrder = 998;
        const descriptor: BuildingHandleDescriptor = {
            getValue,
            setValue,
            getPosition: () => {
                const p = new THREE.Vector3();
                mesh.getWorldPosition(p);
                return p;
            },
            axis,
            sensitivity,
            label,
            min,
            max,
        };
        mesh.userData.buildingHandle = descriptor;
        this.mesh.add(mesh);
        this.handleMeshes.push(mesh);
    }

    private rebuildHandles(): void {
        this.clearHandles();
        if (!this.handlesVisible) return;

        const AXIS_X = new THREE.Vector3(1, 0, 0);
        const AXIS_Y = new THREE.Vector3(0, 1, 0);
        const AXIS_Z = new THREE.Vector3(0, 0, 1);

        for (const segment of this.segments) {
            const cx = segment.node.mesh.position.x;
            const cz = segment.node.mesh.position.z;
            const baseY = segment.node.mesh.position.y;
            const hw = Math.max(MIN_SEGMENT_SIZE, segment.width) / 2;
            const hd = Math.max(MIN_SEGMENT_SIZE, segment.depth) / 2;
            const wallTopY = baseY + segment.wallHeight;

            // Width/depth: a line along the wall face being resized, so it reads as "this is
            // that edge" rather than a dot floating off to the side. Dragging it resizes
            // symmetrically about the segment's own (fixed) center, so the edge only moves
            // half as far as the width/depth change - hence sensitivity 0.5, not 1.
            this.addHandleLine(
                new THREE.Vector3(cx + hw, baseY, cz - hd), new THREE.Vector3(cx + hw, baseY, cz + hd),
                AXIS_X, 0.5, 'Segment Width',
                () => segment.width,
                (v) => { segment.width = Math.max(MIN_SEGMENT_SIZE, v); this.update(); },
                MIN_SEGMENT_SIZE,
            );
            this.addHandleLine(
                new THREE.Vector3(cx - hw, baseY, cz + hd), new THREE.Vector3(cx + hw, baseY, cz + hd),
                AXIS_Z, 0.5, 'Segment Depth',
                () => segment.depth,
                (v) => { segment.depth = Math.max(MIN_SEGMENT_SIZE, v); this.update(); },
                MIN_SEGMENT_SIZE,
            );

            // Wall height: a vertical line spanning the wall's own height, at one corner.
            this.addHandleLine(
                new THREE.Vector3(cx + hw, baseY, cz + hd), new THREE.Vector3(cx + hw, wallTopY, cz + hd),
                AXIS_Y, 1, 'Wall Height',
                () => segment.wallHeight,
                (v) => { segment.wallHeight = Math.max(0.5, v); this.update(); },
                0.5,
            );

            // Roof ridge height: a vertical line from the wall top up to the ridge/apex,
            // common to every pitched roof type (gable, hip, tented and gambrel all read the
            // same roofRidgeHeight field).
            if (segment.roofType !== 'flat') {
                this.addHandleLine(
                    new THREE.Vector3(cx, wallTopY, cz), new THREE.Vector3(cx, wallTopY + segment.roofRidgeHeight, cz),
                    AXIS_Y, 1, 'Roof Ridge Height',
                    () => segment.roofRidgeHeight,
                    (v) => { segment.roofRidgeHeight = Math.max(0.1, v); this.update(); },
                    0.1,
                );
            }

            // Hip ridge length: a line along the ridge itself (both ends move together as
            // the ratio changes), only meaningful for 'hip' - 'tented' always collapses it
            // to a point and every other type has no ridge line at all.
            if (segment.roofType === 'hip') {
                const ridgeAlongX = segment.roofDirection === 'x' ? true
                    : segment.roofDirection === 'z' ? false
                    : segment.width >= segment.depth;
                const overhang = Math.max(0, segment.roofOverhang);
                const wallHalfWidth = hw + FOOTPRINT_UNION_PADDING;
                const wallHalfDepth = hd + FOOTPRINT_UNION_PADDING;
                const halfWidth = wallHalfWidth + overhang;
                const halfDepth = wallHalfDepth + overhang;
                const ridgeHalfLenMax = (ridgeAlongX ? halfWidth : halfDepth) * 0.95;
                const ridgeHalfLen = THREE.MathUtils.clamp(segment.hipRidgeRatio, 0, 1) * ridgeHalfLenMax;
                const ridgeY = wallTopY + segment.roofRidgeHeight;
                const ridgeA = ridgeAlongX
                    ? new THREE.Vector3(cx - ridgeHalfLen, ridgeY, cz)
                    : new THREE.Vector3(cx, ridgeY, cz - ridgeHalfLen);
                const ridgeB = ridgeAlongX
                    ? new THREE.Vector3(cx + ridgeHalfLen, ridgeY, cz)
                    : new THREE.Vector3(cx, ridgeY, cz + ridgeHalfLen);
                // Degenerate (ridge collapsed to a point, ratio 0) - fall back to a minimal
                // visible nub along the ridge axis so there's still something to grab.
                const axisDir = ridgeAlongX ? AXIS_X : AXIS_Z;
                const a = ridgeHalfLen > 1e-3 ? ridgeA : ridgeA.clone().addScaledVector(axisDir, -0.15);
                const b = ridgeHalfLen > 1e-3 ? ridgeB : ridgeB.clone().addScaledVector(axisDir, 0.15);
                this.addHandleLine(
                    a, b, axisDir, ridgeHalfLenMax, 'Hip Ridge Length',
                    () => segment.hipRidgeRatio,
                    (v) => { segment.hipRidgeRatio = THREE.MathUtils.clamp(v, 0, 1); this.update(); },
                    0, 1,
                );
            }
        }

        for (const roofWindow of this.roofWindows) {
            const pos = roofWindow.node.mesh.position;
            const segIndex = this.findGableSegmentIndexForPoint(pos.x, pos.z);
            if (segIndex < 0) continue;
            const { clampedX, clampedZ, y, outward, along } = this.computeGableRoofPlacement(this.segments[segIndex], pos.x, pos.z);
            const frontCenter = new THREE.Vector3(clampedX, y, clampedZ);
            const halfW = roofWindow.width / 2;
            const wallTopY = y + roofWindow.wallHeight;
            const ridgeApexY = wallTopY + roofWindow.ridgeHeight;

            // Width: a vertical line at the wall's own +along edge - same convention the
            // segment handles above use (line runs perpendicular to its own drag axis).
            this.addHandleLine(
                frontCenter.clone().addScaledVector(along, halfW),
                frontCenter.clone().addScaledVector(along, halfW).setY(wallTopY),
                along, 0.5, 'Roof Window Width',
                () => roofWindow.width,
                (v) => { roofWindow.width = Math.max(0.3, v); this.update(); },
                0.3,
            );

            // Depth: a horizontal line along the -along edge, from the front wall back to
            // where the dormer's own footprint ends.
            const depthEdgeFront = frontCenter.clone().addScaledVector(along, -halfW);
            this.addHandleLine(
                depthEdgeFront, depthEdgeFront.clone().addScaledVector(outward, -roofWindow.depth),
                outward.clone().negate(), 1, 'Roof Window Depth',
                () => roofWindow.depth,
                (v) => { roofWindow.depth = Math.max(0.3, v); this.update(); },
                0.3,
            );

            // Wall height / ridge height: stacked vertical lines through the wall's own
            // centerline, matching the segment handles' "Wall Height"/"Roof Ridge Height"
            // pair exactly.
            this.addHandleLine(
                frontCenter.clone(), frontCenter.clone().setY(wallTopY),
                AXIS_Y, 1, 'Roof Window Wall Height',
                () => roofWindow.wallHeight,
                (v) => { roofWindow.wallHeight = Math.max(0.1, v); this.update(); },
                0.1,
            );
            this.addHandleLine(
                frontCenter.clone().setY(wallTopY), frontCenter.clone().setY(ridgeApexY),
                AXIS_Y, 1, 'Roof Window Ridge Height',
                () => roofWindow.ridgeHeight,
                (v) => { roofWindow.ridgeHeight = Math.max(0.1, v); this.update(); },
                0.1,
            );
        }
    }

    protected override getGeometry(): GeometryGroup[] {
        const anchor = this.getAnchor();
        const windows = new Map<string, Triangle[]>();
        const doors = new Map<string, Triangle[]>();
        const walls = new Map<string, Triangle[]>();
        const roof = new Map<string, Triangle[]>();
        const railing = new Map<string, Triangle[]>();
        const gableWalls = new Map<string, Triangle[]>();

        // Every pitched segment always gets its own roof, sized to its own rectangle and
        // built from its own wall height, ridge height and overhang - no merged/shared roof
        // (see buildGableRoofForRect's own note on why). Where two touching segments' roof
        // volumes overlap, they simply interpenetrate rather than forming a true
        // architectural valley - real hip/valley intersection is a straight-skeleton problem
        // well beyond what a level editor's prop building needs. Bucketed directly by that
        // segment's own index - no matching needed, each pitched roof is already built one
        // segment at a time.
        this.segments.forEach((segment, index) => {
            if (segment.roofType === 'flat') return;
            const ridgeAlongX = segment.roofDirection === 'x' ? true
                : segment.roofDirection === 'z' ? false
                : segment.width >= segment.depth;
            const cx = segment.node.mesh.position.x;
            const cz = segment.node.mesh.position.z;
            const baseY = anchor.y + segment.wallHeight;
            const roofKey = `roof#${index}`;
            const gableKey = `gableWalls#${index}`;
            const roofOut = this.bucket(roof, roofKey);
            const gableOut = this.bucket(gableWalls, gableKey);
            switch (segment.roofType) {
                case 'gable':
                    roofOut.push(...this.buildGableRoofForRect(
                        cx, cz, segment.width, segment.depth,
                        baseY, segment.roofRidgeHeight, segment.roofOverhang, ridgeAlongX,
                        gableOut, this.getUVFor(roofKey), this.getUVFor(gableKey), windows, doors,
                    ));
                    break;
                case 'hip':
                    roofOut.push(...this.buildHipRoofForRect(
                        cx, cz, segment.width, segment.depth,
                        baseY, segment.roofRidgeHeight, segment.roofOverhang, ridgeAlongX, segment.hipRidgeRatio,
                        this.getUVFor(roofKey),
                    ));
                    break;
                case 'tented':
                    roofOut.push(...this.buildHipRoofForRect(
                        cx, cz, segment.width, segment.depth,
                        baseY, segment.roofRidgeHeight, segment.roofOverhang, ridgeAlongX, 0,
                        this.getUVFor(roofKey),
                    ));
                    break;
                case 'gambrel':
                    roofOut.push(...this.buildProfiledGableRoofForRect(
                        cx, cz, segment.width, segment.depth,
                        baseY, segment.roofRidgeHeight, segment.roofOverhang, ridgeAlongX,
                        this.buildGambrelProfile(segment.gambrelSegments, segment.gambrelRoundness),
                        gableOut, this.getUVFor(roofKey), this.getUVFor(gableKey), windows, doors,
                    ));
                    break;
                default:
                    break;
            }
        });

        for (const group of this.groupSegmentsByHeight()) {
            const groupHeight = group[0].wallHeight;
            const groupIndices = group.map((segment) => this.segments.indexOf(segment));
            const groupPolygons = this.computeFootprintPolygons(group);
            const groupEdges = this.collectWallEdges(groupPolygons);

            // A pure-flat-roof group's own flat slab (below) already lays a thickness-tall
            // fascia band from (topY - roofThickness) to topY along this exact same boundary
            // - if the ordinary wall also reached all the way up to topY, that band would be
            // covered twice by two different, exactly coplanar quads (one wall-textured, one
            // roof-textured), which is what the reported z-fighting between the parapet/roof
            // edge and the wall right below it actually was. Stopping the wall short leaves
            // that band to the slab's own fascia instead. A mixed group (flat segments next
            // to pitched ones at the same height) keeps the wall at full height - a pitched
            // segment has no such fascia band to hand off to, and narrowing the wall there
            // would open a gap under its eave.
            const isPureFlat = group.every((segment) => segment.roofType === 'flat');
            const wallHeight = isPureFlat
                ? Math.max(0.1, groupHeight - Math.max(0.02, this.roofThickness))
                : groupHeight;
            this.buildWallStrip(
                groupEdges, anchor.y, wallHeight, walls,
                (a2, b2) => `walls#${this.matchSegmentIndexForEdge(a2, b2, groupIndices)}`,
                true, windows, doors,
            );

            const flatSegments = group.filter((segment) => segment.roofType === 'flat');
            if (flatSegments.length > 0) {
                const topY = anchor.y + groupHeight;
                const flatIndices = flatSegments.map((segment) => this.segments.indexOf(segment));
                const flatPolygons = this.computeFootprintPolygons(flatSegments);
                const flatEdges = this.collectWallEdges(flatPolygons);
                this.buildFlatRoofSlab(flatIndices, flatPolygons, flatEdges, topY, roof);

                const railingSegments = flatSegments.filter((segment) => segment.railingEnabled);
                for (const sub of this.groupByRailingSettings(railingSegments)) {
                    const subIndices = sub.map((segment) => this.segments.indexOf(segment));
                    const subEdges = this.collectWallEdges(this.computeFootprintPolygons(sub));
                    this.buildParapetStrip(
                        subEdges, topY, Math.max(0.1, sub[0].railingHeight), Math.max(0.02, sub[0].railingThickness),
                        railing, (a2, b2) => `railing#${this.matchSegmentIndexForEdge(a2, b2, subIndices)}`,
                    );
                }
            }
        }

        this.buildRoofWindows(walls, roof, windows);

        const groups: GeometryGroup[] = [];
        for (const [name, triangles] of walls) groups.push({ name, triangles });
        for (const [name, triangles] of roof) groups.push({ name, triangles });
        for (const [name, triangles] of railing) groups.push({ name, triangles });
        for (const [name, triangles] of gableWalls) groups.push({ name, triangles });
        for (const [name, triangles] of windows) groups.push({ name, triangles });
        for (const [name, triangles] of doors) groups.push({ name, triangles });
        return groups;
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
    // space edges, bucketing each edge's quads into wallsOut under whichever group name
    // groupKeyForEdge assigns it (see the class-level note on per-segment texture groups).
    // windowsOut/doorsOut collect the 3D frame/pane inserts for any opening actually cut,
    // each under its own per-opening group (see appendOpeningInsert/appendWallSegment).
    private buildWallStrip(
        edges: WallEdge[],
        baseY: number,
        height: number,
        wallsOut: Map<string, Triangle[]>,
        groupKeyForEdge: (a2: Point2, b2: Point2) => string,
        withOpenings: boolean,
        windowsOut: Map<string, Triangle[]>,
        doorsOut: Map<string, Triangle[]>,
    ): void {
        if (edges.length === 0 || height <= 0) return;
        const centroid = this.computeEdgeCentroid(edges);

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
            const groupKey = groupKeyForEdge(a2, b2);
            const openings = withOpenings ? this.collectOpeningsForEdge(a2, b2, baseY, baseY + height) : [];
            this.appendWallSegment(
                this.bucket(wallsOut, groupKey), this.getUVFor(groupKey),
                windowsOut, doorsOut, a2, b2, baseY, height, openings,
            );
        }
    }

    private computeEdgeCentroid(edges: WallEdge[]): THREE.Vector3 {
        const centroid = new THREE.Vector3();
        for (const edge of edges) centroid.add(new THREE.Vector3(edge.a[0], 0, edge.a[1]));
        return centroid.multiplyScalar(edges.length > 0 ? 1 / edges.length : 0);
    }

    private appendWallSegment(
        out: Triangle[],
        uv: UVTransform,
        windowsOut: Map<string, Triangle[]>,
        doorsOut: Map<string, Triangle[]>,
        a2: Point2,
        b2: Point2,
        baseY: number,
        height: number,
        openings: WallOpening[],
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
            const paneKey = `${opening.groupPrefix ?? (opening.type === 'door' ? 'doors' : 'windows')}#${opening.index}`;
            const paneArr = this.bucket(opening.type === 'door' ? doorsOut : windowsOut, paneKey);
            this.appendOpeningInsert(
                paneArr, out,
                point3, outward, u0, v0, u1, v1, opening.depth,
                this.getUVFor(paneKey), uv,
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

        this.openings.forEach((entry, index) => {
            const pos = entry.node.mesh.position;
            if (pos.y < minY - HEIGHT_SNAP_MARGIN || pos.y > maxY + HEIGHT_SNAP_MARGIN) return;
            const relX = pos.x - a2[0];
            const relZ = pos.z - a2[1];
            const t = relX * dx + relZ * dz;
            if (t < -WALL_SNAP_MARGIN || t > length + WALL_SNAP_MARGIN) return;
            const perp = Math.abs(relX * dz - relZ * dx);
            if (perp > WALL_SNAP_DISTANCE) return;
            result.push({
                u: THREE.MathUtils.clamp(t, 0, length),
                width: entry.width,
                height: entry.height,
                sill: pos.y - anchorY,
                depth: entry.depth,
                type: entry.type,
                index,
            });
        });
        return result;
    }

    // --- roofs -------------------------------------------------------------------

    private buildFlatRoofSlab(
        flatIndices: number[],
        polygons: FootprintPolygon[],
        edges: WallEdge[],
        topY: number,
        roofOut: Map<string, Triangle[]>,
    ): void {
        const thickness = Math.max(0.02, this.roofThickness);
        const bottomY = topY - thickness;
        for (const polygon of polygons) {
            for (const [pa, pb, pc] of this.triangulatePolygon(polygon)) {
                const centroid: Point2 = [(pa.x + pb.x + pc.x) / 3, (pa.y + pb.y + pc.y) / 3];
                const segIndex = this.matchSegmentIndexForPoint(centroid, flatIndices);
                const key = `roof#${segIndex}`;
                const uv = this.getUVFor(key);
                const uvFor = (p: THREE.Vector2): THREE.Vector2 => new THREE.Vector2(p.x * 0.2 * uv.scaleX + uv.offsetX, p.y * 0.2 * uv.scaleY + uv.offsetY);
                const at = (p: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(p.x, y, p.y);
                const arr = this.bucket(roofOut, key);
                arr.push(new Triangle(at(pa, topY), at(pb, topY), at(pc, topY), uvFor(pa), uvFor(pb), uvFor(pc)));
                arr.push(new Triangle(at(pa, bottomY), at(pc, bottomY), at(pb, bottomY), uvFor(pa), uvFor(pc), uvFor(pb)));
            }
        }
        // The fascia closing the slab's outer (and any inner-hole) edges is the exact same
        // vertical box-strip operation the walls already use - just spanning from the
        // underside up to the top surface instead of from the ground up. See getGeometry's
        // own note on why the ordinary wall below stops short of topY for a pure-flat group,
        // leaving exactly this band free for the fascia rather than the two overlapping.
        this.buildWallStrip(
            edges, bottomY, thickness, roofOut,
            (a2, b2) => `roof#${this.matchSegmentIndexForEdge(a2, b2, flatIndices)}`,
            false, new Map(), new Map(),
        );
    }

    // A solid parapet wall around a flat roof's edge: an outer face, an inner face (facing
    // back toward the roof), and a top cap - a real 3D "murek", not the single infinitely-
    // thin plane the ordinary walls use (a parapet is looked at edge-on far more often than
    // a wall is, so its lack of thickness was much more noticeable).
    private buildParapetStrip(
        edges: WallEdge[],
        baseY: number,
        height: number,
        thickness: number,
        railingOut: Map<string, Triangle[]>,
        groupKeyForEdge: (a2: Point2, b2: Point2) => string,
    ): void {
        if (edges.length === 0 || height <= 0) return;
        const centroid = this.computeEdgeCentroid(edges);

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
            const groupKey = groupKeyForEdge(a2, b2);
            const uv = this.getUVFor(groupKey);
            const out = this.bucket(railingOut, groupKey);
            const uvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * uv.scaleX + uv.offsetX, v * uv.scaleY + uv.offsetY);
            const addQuad = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, uWidth: number, vHeight: number): void => {
                out.push(new Triangle(p0, p1, p2, uvFor(0, 0), uvFor(uWidth, 0), uvFor(uWidth, vHeight)));
                out.push(new Triangle(p0, p2, p3, uvFor(0, 0), uvFor(uWidth, vHeight), uvFor(0, vHeight)));
            };

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
        uv: UVTransform,
        gableUv: UVTransform,
        windowsOut: Map<string, Triangle[]>,
        doorsOut: Map<string, Triangle[]>,
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
                const paneKey = `${opening.groupPrefix ?? (opening.type === 'door' ? 'doors' : 'windows')}#${opening.index}`;
                const paneArr = this.bucket(opening.type === 'door' ? doorsOut : windowsOut, paneKey);
                this.appendOpeningInsert(
                    paneArr, gableWallsOut,
                    point3, outward, u0, v0, u1, v1, opening.depth,
                    this.getUVFor(paneKey), gableUv,
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

    // --- additional roof shapes ------------------------------------------------------

    // heightFrac is divided evenly (N equal height steps from ridge to eave); the matching
    // horizontal distance is heightFrac raised to a power driven by roundness. At roundness
    // 0 the exponent is 1, so distance tracks height linearly (a plain straight gable, just
    // subdivided). Roundness > 0 raises the exponent above 1: distance grows slowly near the
    // ridge and rapidly near the eave - a steep upper run and a flared, shallow lower run,
    // the classic convex barn silhouette. Roundness < 0 pushes the exponent below 1 (but
    // always > 0, so it never blows up at the ridge): distance grows rapidly near the ridge
    // and slowly near the eave instead - a concave, reverse-curved profile.
    private buildGambrelProfile(segments: number, roundness: number): { t: number; h: number }[] {
        const n = Math.max(2, Math.round(segments));
        const exponent = Math.pow(2, THREE.MathUtils.clamp(roundness, -0.95, 0.95) * 3);
        const profile: { t: number; h: number }[] = [];
        for (let i = 0; i <= n; i++) {
            const heightFrac = i / n;
            profile.push({ t: Math.pow(heightFrac, exponent), h: 1 - heightFrac });
        }
        return profile;
    }

    // A gable roof whose slope, instead of one straight run from ridge to eave, follows an
    // arbitrary piecewise-linear profile (ridge at profile[0] = {t:0,h:1}, eave at the last
    // entry = {t:1,h:0}) - currently only used for gambrel (an N-point profile approximating
    // a barrel curve), kept general in case another profiled roof is added later. The gable
    // end walls follow the same profile (scaled to the wall's own, non-overhang footprint)
    // so the roof and end wall always meet exactly regardless of the profile's shape. Each
    // slope segment gets the same real 3D thickness/fascia treatment buildGableRoofForRect's
    // own single-segment panels use (see addThickPanel there) - just repeated once per
    // profile step instead of once per whole slope.
    //
    // Opening clipping on the end wall still uses a single straight ridge-to-corner line as
    // the height limit (not each individual kink) - a conservative approximation that keeps
    // a window correctly clear of the roofline even though it doesn't hug an actual kink.
    private buildProfiledGableRoofForRect(
        cx: number,
        cz: number,
        rectWidth: number,
        rectDepth: number,
        baseY: number,
        ridgeHeight: number,
        overhang: number,
        ridgeAlongX: boolean,
        profile: { t: number; h: number }[],
        gableWallsOut: Triangle[],
        uv: UVTransform,
        gableUv: UVTransform,
        windowsOut: Map<string, Triangle[]>,
        doorsOut: Map<string, Triangle[]>,
    ): Triangle[] {
        overhang = Math.max(0, overhang);
        const wallHalfWidth = Math.max(MIN_SEGMENT_SIZE, rectWidth) / 2 + FOOTPRINT_UNION_PADDING;
        const wallHalfDepth = Math.max(MIN_SEGMENT_SIZE, rectDepth) / 2 + FOOTPRINT_UNION_PADDING;
        const halfWidth = wallHalfWidth + overhang;
        const halfDepth = wallHalfDepth + overhang;
        const ridgeDrop = Math.max(0.1, ridgeHeight);
        const ridgeY = baseY + ridgeDrop;

        const uvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * uv.scaleX + uv.offsetX, v * uv.scaleY + uv.offsetY);
        const gableUvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * gableUv.scaleX + gableUv.offsetX, v * gableUv.scaleY + gableUv.offsetY);
        const triangles: Triangle[] = [];
        const thickness = Math.max(0.02, this.roofThickness);

        // Real 3D thickness: a top face, a bottom face, and fascia strips - but only on the
        // two edges that run along the slope's own width (always a true boundary, matching
        // the gable end wall), plus the ridge-ward edge when this is the first segment and
        // the eave-ward edge when it's the last. A profile with more than one segment shares
        // its intermediate breakpoint edges between two consecutive panels with different
        // slopes (that's the whole point of a profile), and fasciaing a shared edge at all
        // produced a visible wedge poking out at the seam - fixed by only fasciaing
        // genuinely unshared edges (see buildHipRoofForRect's own note on the same fix).
        // The bottom face is offset straight down rather than along the panel's own normal -
        // two adjacent panels' corners need to land on the exact same point directly below
        // the shared top corner, and only a fixed world-down offset guarantees that
        // regardless of which panel's (different) normal is doing the computing; a
        // per-panel-normal offset put the two panels' bottom corners at different points,
        // which is what the reported "corner" gap/wedge actually was.
        const addThickPanel = (
            p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3,
            isFirstSegment: boolean, isLastSegment: boolean,
        ): void => {
            const corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] = [p0, p1, p2, p3];
            const offset = new THREE.Vector3(0, -thickness, 0);
            const bottom = corners.map((c) => c.clone().add(offset)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
            const widthDist = p0.distanceTo(p1);
            const heightDist = p0.distanceTo(p3);
            triangles.push(new Triangle(p0, p1, p2, uvFor(0, 0), uvFor(widthDist, 0), uvFor(widthDist, heightDist)));
            triangles.push(new Triangle(p0, p2, p3, uvFor(0, 0), uvFor(widthDist, heightDist), uvFor(0, heightDist)));
            triangles.push(new Triangle(bottom[2], bottom[1], bottom[0], uvFor(widthDist, heightDist), uvFor(widthDist, 0), uvFor(0, 0)));
            triangles.push(new Triangle(bottom[3], bottom[2], bottom[0], uvFor(0, heightDist), uvFor(widthDist, heightDist), uvFor(0, 0)));
            const fasciaEdges = [isFirstSegment, true, isLastSegment, true];
            for (let i = 0; i < 4; i++) {
                if (!fasciaEdges[i]) continue;
                const j = (i + 1) % 4;
                const edgeLength = corners[i].distanceTo(corners[j]);
                triangles.push(new Triangle(corners[j], corners[i], bottom[i], uvFor(0, 0), uvFor(edgeLength, 0), uvFor(edgeLength, thickness)));
                triangles.push(new Triangle(corners[j], bottom[i], bottom[j], uvFor(0, 0), uvFor(edgeLength, thickness), uvFor(0, thickness)));
            }
        };

        // Each step down the profile reuses the exact same corner-order template
        // buildGableRoofForRect's own (single-segment) panels use, just at the profile's
        // intermediate heights instead of jumping straight from ridge to eave.
        if (ridgeAlongX) {
            for (let i = 0; i < profile.length - 1; i++) {
                const isFirst = i === 0;
                const isLast = i === profile.length - 2;
                const y0 = baseY + profile[i].h * ridgeDrop;
                const y1 = baseY + profile[i + 1].h * ridgeDrop;
                const zNear0 = cz - profile[i].t * halfDepth;
                const zNear1 = cz - profile[i + 1].t * halfDepth;
                const zFar0 = cz + profile[i].t * halfDepth;
                const zFar1 = cz + profile[i + 1].t * halfDepth;
                addThickPanel(
                    new THREE.Vector3(cx - halfWidth, y0, zNear0), new THREE.Vector3(cx + halfWidth, y0, zNear0),
                    new THREE.Vector3(cx + halfWidth, y1, zNear1), new THREE.Vector3(cx - halfWidth, y1, zNear1),
                    isFirst, isLast,
                );
                addThickPanel(
                    new THREE.Vector3(cx + halfWidth, y0, zFar0), new THREE.Vector3(cx - halfWidth, y0, zFar0),
                    new THREE.Vector3(cx - halfWidth, y1, zFar1), new THREE.Vector3(cx + halfWidth, y1, zFar1),
                    isFirst, isLast,
                );
            }
        } else {
            for (let i = 0; i < profile.length - 1; i++) {
                const isFirst = i === 0;
                const isLast = i === profile.length - 2;
                const y0 = baseY + profile[i].h * ridgeDrop;
                const y1 = baseY + profile[i + 1].h * ridgeDrop;
                const xNear0 = cx - profile[i].t * halfWidth;
                const xNear1 = cx - profile[i + 1].t * halfWidth;
                const xFar0 = cx + profile[i].t * halfWidth;
                const xFar1 = cx + profile[i + 1].t * halfWidth;
                addThickPanel(
                    new THREE.Vector3(xNear1, y1, cz - halfDepth), new THREE.Vector3(xNear1, y1, cz + halfDepth),
                    new THREE.Vector3(xNear0, y0, cz + halfDepth), new THREE.Vector3(xNear0, y0, cz - halfDepth),
                    isLast, isFirst,
                );
                addThickPanel(
                    new THREE.Vector3(xFar1, y1, cz + halfDepth), new THREE.Vector3(xFar1, y1, cz - halfDepth),
                    new THREE.Vector3(xFar0, y0, cz - halfDepth), new THREE.Vector3(xFar0, y0, cz + halfDepth),
                    isLast, isFirst,
                );
            }
        }

        // Same apex auto-detection and cyclic-rotation-to-(a,b,apex) trick
        // buildGableRoofForRect's addGableWall uses, so this can be called with the exact
        // same argument order/positions that were already verified outward-facing there -
        // only the contour built from (a,b,apex) is new (a fan through the profile's
        // intermediate points instead of a plain 3-point triangle).
        const addProfiledGableWall = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3): void => {
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
            const apexV = apex.y - a.y;
            const half = width / 2;

            const contour: THREE.Vector2[] = [new THREE.Vector2(0, 0), new THREE.Vector2(width, 0)];
            for (let i = profile.length - 2; i >= 1; i--) contour.push(new THREE.Vector2(half + half * profile[i].t, profile[i].h * apexV));
            contour.push(new THREE.Vector2(half, apexV));
            for (let i = 1; i <= profile.length - 2; i++) contour.push(new THREE.Vector2(half - half * profile[i].t, profile[i].h * apexV));

            const limitAt = (u: number): number => (u <= half
                ? apexV * (u / Math.max(1e-4, half))
                : apexV * ((width - u) / Math.max(1e-4, half)));

            const openings = this.collectOpeningsForEdge([a.x, a.z], [b.x, b.z], baseY, ridgeY);
            const holes: THREE.Vector2[][] = [];
            for (const opening of openings) {
                const halfW = opening.width / 2;
                const u0 = THREE.MathUtils.clamp(opening.u - halfW, WALL_SNAP_MARGIN, width - WALL_SNAP_MARGIN);
                const u1 = THREE.MathUtils.clamp(opening.u + halfW, WALL_SNAP_MARGIN, width - WALL_SNAP_MARGIN);
                if (u1 - u0 < 0.1) continue;
                const limit = Math.min(limitAt(u0), limitAt(u1)) - 0.1;
                if (limit <= 0.15) continue;
                const v0 = THREE.MathUtils.clamp(opening.sill, 0.02, limit - 0.1);
                const v1 = Math.min(opening.sill + opening.height, limit);
                if (v1 - v0 < 0.1) continue;
                holes.push([new THREE.Vector2(u0, v0), new THREE.Vector2(u1, v0), new THREE.Vector2(u1, v1), new THREE.Vector2(u0, v1)]);
                const paneKey = `${opening.groupPrefix ?? (opening.type === 'door' ? 'doors' : 'windows')}#${opening.index}`;
                const paneArr = this.bucket(opening.type === 'door' ? doorsOut : windowsOut, paneKey);
                this.appendOpeningInsert(
                    paneArr, gableWallsOut,
                    point3, outward, u0, v0, u1, v1, opening.depth,
                    this.getUVFor(paneKey), gableUv,
                );
            }

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

        if (ridgeAlongX) {
            addProfiledGableWall(
                new THREE.Vector3(cx - wallHalfWidth, baseY, cz - wallHalfDepth),
                new THREE.Vector3(cx - wallHalfWidth, baseY, cz + wallHalfDepth),
                new THREE.Vector3(cx - wallHalfWidth, ridgeY, cz),
            );
            addProfiledGableWall(
                new THREE.Vector3(cx + wallHalfWidth, baseY, cz - wallHalfDepth),
                new THREE.Vector3(cx + wallHalfWidth, ridgeY, cz),
                new THREE.Vector3(cx + wallHalfWidth, baseY, cz + wallHalfDepth),
            );
        } else {
            addProfiledGableWall(
                new THREE.Vector3(cx - wallHalfWidth, baseY, cz - wallHalfDepth),
                new THREE.Vector3(cx, ridgeY, cz - wallHalfDepth),
                new THREE.Vector3(cx + wallHalfWidth, baseY, cz - wallHalfDepth),
            );
            addProfiledGableWall(
                new THREE.Vector3(cx - wallHalfWidth, baseY, cz + wallHalfDepth),
                new THREE.Vector3(cx + wallHalfWidth, baseY, cz + wallHalfDepth),
                new THREE.Vector3(cx, ridgeY, cz + wallHalfDepth),
            );
        }

        return triangles;
    }

    // A hip roof: all four sides slope up to a ridge line (tented=true collapses the ridge
    // to a single point, forming a pyramid instead) - no vertical gable end walls at all, so
    // no opening-cutting applies here (a hip/tented segment can still have windows cut into
    // its ordinary walls below the roofline, just not into the roof itself). Ridge half-
    // length uses the standard equal-pitch-on-all-sides convention (long dimension minus
    // short dimension), clamped to zero (a pyramid) once the footprint is square enough that
    // convention would go negative.
    private buildHipRoofForRect(
        cx: number,
        cz: number,
        rectWidth: number,
        rectDepth: number,
        baseY: number,
        ridgeHeight: number,
        overhang: number,
        ridgeAlongX: boolean,
        ridgeRatio: number,
        uv: UVTransform,
    ): Triangle[] {
        overhang = Math.max(0, overhang);
        const wallHalfWidth = Math.max(MIN_SEGMENT_SIZE, rectWidth) / 2 + FOOTPRINT_UNION_PADDING;
        const wallHalfDepth = Math.max(MIN_SEGMENT_SIZE, rectDepth) / 2 + FOOTPRINT_UNION_PADDING;
        const halfWidth = wallHalfWidth + overhang;
        const halfDepth = wallHalfDepth + overhang;
        const ridgeY = baseY + Math.max(0.1, ridgeHeight);
        // Scales with the ridge's own axis only (not "long side minus short side") so a
        // forced direction still produces a real ridge even when that axis is the shorter
        // of the two - the old long-minus-short convention went negative (clamped to 0, a
        // pyramid) whenever the ridge was forced onto the shorter axis. The 0.95 cap keeps a
        // sliver of hip end visible even at ridgeRatio 1 instead of the ends vanishing
        // entirely into the eave corners.
        const ridgeHalfLenMax = (ridgeAlongX ? halfWidth : halfDepth) * 0.95;
        const ridgeHalfLen = THREE.MathUtils.clamp(ridgeRatio, 0, 1) * ridgeHalfLenMax;

        const uvFor = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u * uv.scaleX + uv.offsetX, v * uv.scaleY + uv.offsetY);
        const triangles: Triangle[] = [];
        const thickness = Math.max(0.02, this.roofThickness);

        // Real 3D thickness: a top face, a bottom face, and a fascia strip ONLY along the
        // one edge given as eaveEdge - unlike buildGableRoofForRect's 2-panel gable (where
        // every edge is either the ridge or a true boundary), a hip roof's panels also share
        // edges with their NEIGHBOURING panels (the diagonal hip lines, and the ridge line
        // itself) at a different dihedral angle each. Fascia-ing those shared edges too
        // produced a visible wedge poking out wherever two panels meet - only the outer eave
        // edge is a true unshared boundary, so it's the only one that gets a fascia strip.
        // The bottom face is offset straight down (not along the panel's own normal) so
        // that two adjacent panels sharing a top corner land on the exact same bottom point
        // there regardless of their different normals - offsetting along each panel's own
        // normal put the two panels' corners at different points, which is what the
        // reported wedge at the roof corners actually was.
        const addThickTri = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, eaveEdge: [number, number]): void => {
            const corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [p0, p1, p2];
            const offset = new THREE.Vector3(0, -thickness, 0);
            const bottom = corners.map((c) => c.clone().add(offset)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
            const ab = p0.distanceTo(p1);
            const ac = p0.distanceTo(p2);
            triangles.push(new Triangle(p0, p1, p2, uvFor(0, 0), uvFor(ab, 0), uvFor(ac, ac)));
            triangles.push(new Triangle(bottom[2], bottom[1], bottom[0], uvFor(ac, ac), uvFor(ab, 0), uvFor(0, 0)));
            const [i, j] = eaveEdge;
            const edgeLength = corners[i].distanceTo(corners[j]);
            triangles.push(new Triangle(corners[j], corners[i], bottom[i], uvFor(0, 0), uvFor(edgeLength, 0), uvFor(edgeLength, thickness)));
            triangles.push(new Triangle(corners[j], bottom[i], bottom[j], uvFor(0, 0), uvFor(edgeLength, thickness), uvFor(0, thickness)));
        };
        // Falls back to a single thick triangle when the ridge has collapsed to a point
        // (ridgeHalfLen 0, i.e. tented, or hip with hipRidgeRatio near 0) - the quad's two
        // ridge corners coincide in that case, which would otherwise divide by a zero-length
        // cross product when computing the panel's normal. eaveEdgeIfDegenerate is the
        // fallback triangle's own eave-edge index pair, since it's a different pair of
        // corners than the quad's own eaveEdge once one side collapses away.
        const addThickPanel = (
            p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3,
            eaveEdge: [number, number], eaveEdgeIfDegenerate: [number, number],
        ): void => {
            if (p0.distanceToSquared(p1) < 1e-6) { addThickTri(p0, p2, p3, eaveEdgeIfDegenerate); return; }
            if (p2.distanceToSquared(p3) < 1e-6) { addThickTri(p0, p1, p2, eaveEdgeIfDegenerate); return; }
            const corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] = [p0, p1, p2, p3];
            const offset = new THREE.Vector3(0, -thickness, 0);
            const bottom = corners.map((c) => c.clone().add(offset)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
            const widthDist = p0.distanceTo(p1);
            const heightDist = p0.distanceTo(p3);
            triangles.push(new Triangle(p0, p1, p2, uvFor(0, 0), uvFor(widthDist, 0), uvFor(widthDist, heightDist)));
            triangles.push(new Triangle(p0, p2, p3, uvFor(0, 0), uvFor(widthDist, heightDist), uvFor(0, heightDist)));
            triangles.push(new Triangle(bottom[2], bottom[1], bottom[0], uvFor(widthDist, heightDist), uvFor(widthDist, 0), uvFor(0, 0)));
            triangles.push(new Triangle(bottom[3], bottom[2], bottom[0], uvFor(0, heightDist), uvFor(widthDist, heightDist), uvFor(0, 0)));
            const [i, j] = eaveEdge;
            const edgeLength = corners[i].distanceTo(corners[j]);
            triangles.push(new Triangle(corners[j], corners[i], bottom[i], uvFor(0, 0), uvFor(edgeLength, 0), uvFor(edgeLength, thickness)));
            triangles.push(new Triangle(corners[j], bottom[i], bottom[j], uvFor(0, 0), uvFor(edgeLength, thickness), uvFor(0, thickness)));
        };

        // Same corner-order convention as buildGableRoofForRect's own thick panels (verified
        // outward-facing there): [ridge-left, ridge-right, eave-right, eave-left] for the
        // near slope, mirrored for the far slope. The two hip-end triangles use the same
        // "ridge point last" order as a degenerate case of that same pattern.
        if (ridgeAlongX) {
            const ridgeNear = new THREE.Vector3(cx - ridgeHalfLen, ridgeY, cz);
            const ridgeFar = new THREE.Vector3(cx + ridgeHalfLen, ridgeY, cz);
            const eaveA = new THREE.Vector3(cx - halfWidth, baseY, cz - halfDepth);
            const eaveB = new THREE.Vector3(cx + halfWidth, baseY, cz - halfDepth);
            const eaveC = new THREE.Vector3(cx + halfWidth, baseY, cz + halfDepth);
            const eaveD = new THREE.Vector3(cx - halfWidth, baseY, cz + halfDepth);
            addThickPanel(ridgeNear, ridgeFar, eaveB, eaveA, [2, 3], [1, 2]);
            addThickPanel(ridgeFar, ridgeNear, eaveD, eaveC, [2, 3], [1, 2]);
            addThickTri(eaveA, eaveD, ridgeNear, [0, 1]);
            addThickTri(eaveC, eaveB, ridgeFar, [0, 1]);
        } else {
            const ridgeNear = new THREE.Vector3(cx, ridgeY, cz - ridgeHalfLen);
            const ridgeFar = new THREE.Vector3(cx, ridgeY, cz + ridgeHalfLen);
            const eaveA = new THREE.Vector3(cx - halfWidth, baseY, cz - halfDepth);
            const eaveB = new THREE.Vector3(cx - halfWidth, baseY, cz + halfDepth);
            const eaveC = new THREE.Vector3(cx + halfWidth, baseY, cz + halfDepth);
            const eaveD = new THREE.Vector3(cx + halfWidth, baseY, cz - halfDepth);
            addThickPanel(eaveA, eaveB, ridgeFar, ridgeNear, [0, 1], [0, 1]);
            addThickPanel(eaveC, eaveD, ridgeNear, ridgeFar, [0, 1], [0, 1]);
            addThickTri(eaveD, eaveA, ridgeNear, [0, 1]);
            addThickTri(eaveB, eaveC, ridgeFar, [0, 1]);
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
            uvTransforms: Object.fromEntries(this.uvTransforms),
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
                roofType: segment.roofType,
                hipRidgeRatio: segment.hipRidgeRatio,
                gambrelSegments: segment.gambrelSegments,
                gambrelRoundness: segment.gambrelRoundness,
                railingEnabled: segment.railingEnabled,
                railingHeight: segment.railingHeight,
                railingThickness: segment.railingThickness,
            })),
            buildingRoofThickness: this.roofThickness,
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
            buildingRoofWindows: this.roofWindows.map((entry) => ({
                x: entry.node.mesh.position.x,
                y: entry.node.mesh.position.y,
                z: entry.node.mesh.position.z,
                width: entry.width,
                depth: entry.depth,
                wallHeight: entry.wallHeight,
                ridgeHeight: entry.ridgeHeight,
            })),
        };
    }

    public static deserialize(data: ElementData): Building {
        const anchorData = data.nodes[0] ?? { x: 0, y: 0, z: 0 };
        const anchor = new THREE.Vector3(anchorData.x, anchorData.y, anchorData.z);
        const segmentsData = (data.buildingSegments && data.buildingSegments.length > 0)
            ? data.buildingSegments
            : [{ x: anchor.x, y: anchor.y, z: anchor.z, width: 8, depth: 6 }];

        // Legacy saves stored wall/ridge/overhang/railing once for the whole building
        // rather than per segment - fall back to those values (or the same defaults used
        // for a brand new segment) when a segment entry doesn't carry its own.
        const legacyWallHeight = data.buildingWallHeight ?? DEFAULT_WALL_HEIGHT;
        const legacyRidgeHeight = data.buildingRoofRidgeHeight ?? DEFAULT_ROOF_RIDGE_HEIGHT;
        const legacyOverhang = data.buildingRoofOverhang ?? DEFAULT_ROOF_OVERHANG;
        const legacyRailingHeight = data.buildingRailingHeight ?? DEFAULT_RAILING_HEIGHT;
        const legacyRailingThickness = data.buildingRailingThickness ?? DEFAULT_RAILING_THICKNESS;
        const legacyRoofType = data.buildingRoofType === 'gable' ? 'gable' : 'flat';
        const parseDirection = (value: string | undefined): RoofDirection => (value === 'x' || value === 'z' ? value : 'auto');
        const validRoofTypes: RoofType[] = ['flat', 'gable', 'hip', 'tented', 'gambrel'];
        // halfHip and gableBreak were removed shortly after being added - map any save that
        // briefly picked them up to the closest surviving type instead of silently reverting
        // to the legacy default.
        const legacyTypeMigration: Record<string, RoofType> = { halfHip: 'gable', gableBreak: 'gambrel' };
        const parseRoofType = (value: string | undefined): RoofType => {
            if (value && value in legacyTypeMigration) return legacyTypeMigration[value];
            return validRoofTypes.includes(value as RoofType) ? (value as RoofType) : legacyRoofType;
        };

        const building = new Building(anchor, {
            width: segmentsData[0].width,
            depth: segmentsData[0].depth,
            wallHeight: segmentsData[0].wallHeight ?? legacyWallHeight,
            roofRidgeHeight: segmentsData[0].roofRidgeHeight ?? legacyRidgeHeight,
            roofOverhang: segmentsData[0].roofOverhang ?? legacyOverhang,
            roofDirection: parseDirection(segmentsData[0].roofDirection),
            roofType: parseRoofType(segmentsData[0].roofType),
            hipRidgeRatio: segmentsData[0].hipRidgeRatio,
            gambrelSegments: segmentsData[0].gambrelSegments,
            gambrelRoundness: segmentsData[0].gambrelRoundness,
            railingEnabled: segmentsData[0].railingEnabled,
            railingHeight: segmentsData[0].railingHeight ?? legacyRailingHeight,
            railingThickness: segmentsData[0].railingThickness ?? legacyRailingThickness,
        });
        building.getSegmentNode(0).mesh.position.set(segmentsData[0].x, segmentsData[0].y, segmentsData[0].z);
        for (const segment of segmentsData.slice(1)) {
            building.addSegment(new THREE.Vector3(segment.x, segment.y, segment.z), segment.width, segment.depth, {
                wallHeight: segment.wallHeight ?? legacyWallHeight,
                roofRidgeHeight: segment.roofRidgeHeight ?? legacyRidgeHeight,
                roofOverhang: segment.roofOverhang ?? legacyOverhang,
                roofDirection: parseDirection(segment.roofDirection),
                roofType: parseRoofType(segment.roofType),
                hipRidgeRatio: segment.hipRidgeRatio,
                gambrelSegments: segment.gambrelSegments,
                gambrelRoundness: segment.gambrelRoundness,
                railingEnabled: segment.railingEnabled,
                railingHeight: segment.railingHeight ?? legacyRailingHeight,
                railingThickness: segment.railingThickness ?? legacyRailingThickness,
            });
        }

        building.roofThickness = Math.max(0.02, data.buildingRoofThickness ?? 0.15);
        building.cutInGround = data.buildingCutInGround ?? false;

        for (const opening of data.buildingOpenings ?? []) {
            const type = opening.type === 'door' ? 'door' : 'window';
            building.addOpening(new THREE.Vector3(opening.x, opening.y, opening.z), type);
            const entry = building.openings[building.openings.length - 1];
            entry.width = Math.max(0.2, opening.width);
            entry.height = Math.max(0.2, opening.height);
            entry.depth = Math.max(0.02, opening.depth ?? 0.1);
        }

        for (const roofWindow of data.buildingRoofWindows ?? []) {
            building.addRoofWindow(new THREE.Vector3(roofWindow.x, roofWindow.y, roofWindow.z));
            const entry = building.roofWindows[building.roofWindows.length - 1];
            entry.width = Math.max(0.3, roofWindow.width ?? DEFAULT_ROOF_WINDOW_WIDTH);
            entry.depth = Math.max(0.3, roofWindow.depth ?? DEFAULT_ROOF_WINDOW_DEPTH);
            entry.wallHeight = Math.max(0.1, roofWindow.wallHeight ?? DEFAULT_ROOF_WINDOW_WALL_HEIGHT);
            entry.ridgeHeight = Math.max(0.1, roofWindow.ridgeHeight ?? DEFAULT_ROOF_WINDOW_RIDGE_HEIGHT);
        }

        building.update();

        // Legacy saves keyed UV/texture data by one shared name per kind ('walls', 'roof',
        // 'railing', 'gableWalls', 'windows', 'doors') rather than per segment/opening -
        // fan each legacy key out to every live group of that kind so an old save keeps
        // looking the same after loading into the new per-segment scheme, rather than
        // silently losing its textures. Must run after building.update() above so
        // getGroupNames() reflects the actual geometry that was just built.
        Building.migrateLegacyGroupData(data, building);

        const uv = data.uvTransforms ?? {};
        for (const [group, transform] of Object.entries(uv)) {
            building.uvTransforms.set(group, { ...transform });
        }
        building.update();
        return building;
    }

    private static migrateLegacyGroupData(data: ElementData, building: Building): void {
        const prefixFor: Record<string, string> = {
            walls: 'walls#', roof: 'roof#', gableWalls: 'gableWalls#',
            railing: 'railing#', windows: 'windows#', doors: 'doors#',
        };
        data.textures = data.textures ?? {};
        data.textureRotations = data.textureRotations ?? {};
        data.uvTransforms = data.uvTransforms ?? {};
        const liveNames = building.getGroupNames();
        for (const [legacyKey, prefix] of Object.entries(prefixFor)) {
            const path = data.textures[legacyKey];
            const rotation = data.textureRotations[legacyKey];
            const transform = data.uvTransforms[legacyKey];
            if (path === undefined && rotation === undefined && transform === undefined) continue;
            for (const name of liveNames) {
                if (!name.startsWith(prefix)) continue;
                if (path !== undefined && !(name in data.textures)) data.textures[name] = path;
                if (rotation !== undefined && !(name in data.textureRotations)) data.textureRotations[name] = rotation;
                if (transform !== undefined && !(name in data.uvTransforms)) data.uvTransforms[name] = { ...transform };
            }
        }
    }

    public override getProperties(): PropertyDefinition {
        const self = this;
        const uvSizeProperty = (label: string, groupKey: string): SectionItem => ({
            type: 'number',
            label,
            get: () => self.getUVFor(groupKey).scaleX,
            set: (value: number) => {
                const size = THREE.MathUtils.clamp(value, 0.05, 50);
                const current = self.getUVFor(groupKey);
                self.setUVTransform(groupKey, { ...current, scaleX: size, scaleY: size });
            },
            min: 0.05,
            max: 50,
            step: 0.05,
        });

        // No separate "Transform > Anchor" section - since segment 0's own node doubles as
        // the anchor (see the class-level note on why), that would just be a second field
        // editing the exact same position as "Segment 1 > Position" below. No building-wide
        // "Textures" section either - now that every wall/roof/window/etc. group is per-
        // segment/per-opening (see the class-level note), a single global slider wouldn't
        // mean anything; each segment/opening's own section carries its own UV size fields.
        const sections: { label: string; properties: SectionItem[] }[] = [
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
                        label: 'Roof Thickness',
                        get: () => self.roofThickness,
                        set: (value: number) => { self.roofThickness = Math.max(0.02, value); self.update(); },
                        min: 0.02,
                        max: 1,
                        step: 0.01,
                    },
                ],
            },
        ];

        const ROOF_TYPE_OPTIONS = [
            { label: 'Flat (Railing)', value: 'flat' },
            { label: 'Gable (Triangular)', value: 'gable' },
            { label: 'Hip (4-Slope)', value: 'hip' },
            { label: 'Tented (Pyramid)', value: 'tented' },
            { label: 'Gambrel', value: 'gambrel' },
        ];

        this.segments.forEach((segment, index) => {
            const hasGableWalls = segment.roofType === 'gable' || segment.roofType === 'gambrel';
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
                    {
                        type: 'select',
                        label: 'Roof',
                        options: ROOF_TYPE_OPTIONS,
                        get: () => segment.roofType,
                        set: (v: string) => {
                            segment.roofType = (ROOF_TYPE_OPTIONS.some((o) => o.value === v) ? v : 'flat') as RoofType;
                            self.update();
                            self.onPropertiesChanged?.();
                        },
                    },
                    ...(segment.roofType !== 'flat' ? [
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
                    ] : []),
                    ...(segment.roofType !== 'flat' && segment.roofType !== 'tented' ? [{
                        type: 'select' as const,
                        label: 'Roof Direction',
                        options: [
                            { label: 'Auto', value: 'auto' },
                            { label: 'Along Width (X)', value: 'x' },
                            { label: 'Along Depth (Z)', value: 'z' },
                        ],
                        get: () => segment.roofDirection,
                        set: (v: string) => { segment.roofDirection = v === 'x' || v === 'z' ? v : 'auto'; self.update(); },
                    }] : []),
                    ...(segment.roofType === 'hip' ? [{
                        type: 'number' as const,
                        label: 'Ridge Length',
                        get: () => segment.hipRidgeRatio,
                        set: (v: number) => { segment.hipRidgeRatio = THREE.MathUtils.clamp(v, 0, 1); self.update(); },
                        min: 0,
                        max: 1,
                        step: 0.05,
                    }] : []),
                    ...(segment.roofType === 'gambrel' ? [
                        {
                            type: 'number' as const,
                            label: 'Gambrel Segments',
                            get: () => segment.gambrelSegments,
                            set: (v: number) => { segment.gambrelSegments = Math.max(2, Math.round(v)); self.update(); },
                            min: 2,
                            max: 8,
                            step: 1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Roundness',
                            get: () => segment.gambrelRoundness,
                            set: (v: number) => { segment.gambrelRoundness = THREE.MathUtils.clamp(v, -0.95, 0.95); self.update(); },
                            min: -0.95,
                            max: 0.95,
                            step: 0.05,
                        },
                    ] : []),
                    ...(segment.roofType === 'flat' ? [
                        {
                            type: 'boolean' as const,
                            label: 'Railing Enabled',
                            get: () => segment.railingEnabled,
                            set: (v: boolean) => { segment.railingEnabled = v; self.update(); self.onPropertiesChanged?.(); },
                        },
                        ...(segment.railingEnabled ? [
                            {
                                type: 'number' as const,
                                label: 'Railing Height',
                                get: () => segment.railingHeight,
                                set: (v: number) => { segment.railingHeight = Math.max(0.1, v); self.update(); },
                                min: 0.1,
                                max: 3,
                                step: 0.05,
                            },
                            {
                                type: 'number' as const,
                                label: 'Railing Thickness',
                                get: () => segment.railingThickness,
                                set: (v: number) => { segment.railingThickness = Math.max(0.02, v); self.update(); },
                                min: 0.02,
                                max: 1,
                                step: 0.01,
                            },
                            uvSizeProperty('Railing UV Size', `railing#${index}`),
                        ] : []),
                    ] : []),
                    uvSizeProperty('Wall UV Size', `walls#${index}`),
                    uvSizeProperty('Roof UV Size', `roof#${index}`),
                    ...(hasGableWalls ? [uvSizeProperty('Gable Wall UV Size', `gableWalls#${index}`)] : []),
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
                    uvSizeProperty('Texture UV Size', `${opening.type === 'door' ? 'doors' : 'windows'}#${index}`),
                    { type: 'button', label: 'Remove', onClick: () => self.removeOpening(index) },
                ],
            });
        });

        this.roofWindows.forEach((entry, index) => {
            sections.push({
                label: `Roof Window ${index + 1}`,
                properties: [
                    // Y is ignored by the geometry (see computeGableRoofPlacement) - the node
                    // just tracks the last dragged-to point on the roof slope, so exposing X/Z
                    // as a full vector3 field here would be misleading; Position dragging in
                    // the viewport already works via the node itself.
                    { type: 'vector3', label: 'Position', get: () => entry.node.mesh.position.clone(), set: (v: THREE.Vector3) => { entry.node.update(v); self.update(); } },
                    { type: 'number', label: 'Width', get: () => entry.width, set: (v: number) => { entry.width = Math.max(0.3, v); self.update(); }, min: 0.3, max: 6, step: 0.05 },
                    { type: 'number', label: 'Depth', get: () => entry.depth, set: (v: number) => { entry.depth = Math.max(0.3, v); self.update(); }, min: 0.3, max: 6, step: 0.05 },
                    { type: 'number', label: 'Wall Height', get: () => entry.wallHeight, set: (v: number) => { entry.wallHeight = Math.max(0.1, v); self.update(); }, min: 0.1, max: 3, step: 0.05 },
                    { type: 'number', label: 'Roof Ridge Height', get: () => entry.ridgeHeight, set: (v: number) => { entry.ridgeHeight = Math.max(0.1, v); self.update(); }, min: 0.1, max: 2, step: 0.05 },
                    uvSizeProperty('Wall UV Size', `dormerWalls#${index}`),
                    uvSizeProperty('Roof UV Size', `dormerRoof#${index}`),
                    uvSizeProperty('Window UV Size', `dormerWindows#${index}`),
                    { type: 'button', label: 'Remove', onClick: () => self.removeRoofWindow(index) },
                ],
            });
        });

        return { title: 'Building', icon: '&#127968;', sections };
    }
}
