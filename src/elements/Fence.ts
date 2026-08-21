import * as THREE from 'three';
import { container } from 'tsyringe';
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
import { sampleCubicBezier } from '../utils/Bezier';
import type { PropertyDefinition, SectionItem } from '../editor/Properties';
import LODPreviewManager from '../editor/LODPreviewManager';
import { getDivisionsForLOD } from '../export/LODLevels';

export type FenceStyle = 'plane' | 'box';
export type FencePostShape = 'box' | 'circle';
type FenceGroup = 'fence' | 'posts';

const UP = new THREE.Vector3(0, 1, 0);

export default class Fence extends WorldElement {
    public get nodeA(): WorldNode { return this.nodes[0]; }
    public get nodeB(): WorldNode { return this.nodes[1]; }

    public style: FenceStyle = 'plane';
    public height = 1.5;
    public thickness = 0.08;
    public postSpacing = 2;
    public postHeight = 1.8;
    public postWidth = 0.14;
    public postShape: FencePostShape = 'box';
    public postSides = 12;
    public maxAngleStep = 30;

    private _divisions = 0;
    private curvePointA: WorldNode | null = null;
    private curvePointB: WorldNode | null = null;
    private curveLine: THREE.Line | null = null;
    private handleLineA: THREE.Line | null = null;
    private handleLineB: THREE.Line | null = null;
    private readonly uvTransforms = new Map<FenceGroup, UVTransform>([
        ['fence', { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 }],
        ['posts', { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 }],
    ]);

    public get divisions(): number { return this._divisions; }
    public set divisions(value: number) {
        this._divisions = Math.max(0, Math.round(value));
        if (this._divisions > 0) {
            const a = this.nodeA.mesh.position;
            const b = this.nodeB.mesh.position;
            if (!this.curvePointA) this.setCurvePointA(a.clone().lerp(b, 1 / 3));
            if (!this.curvePointB) this.setCurvePointB(a.clone().lerp(b, 2 / 3));
        } else {
            this.setCurvePointA(null);
            this.setCurvePointB(null);
        }
        this.updateCurveLines();
    }

    constructor(positionA: THREE.Vector3, positionB: THREE.Vector3) {
        super();
        this.setNode(0, new WorldNode(positionA, Config.editor.nodeColor));
        this.setNode(1, new WorldNode(positionB, Config.editor.nodeColor));
        this.mesh.castShadow = true;
    }

    public setCurvePointA(point: THREE.Vector3 | null): void {
        this.curvePointA = this.setCurvePoint(this.curvePointA, point);
        this.updateCurveLines();
    }

    public setCurvePointB(point: THREE.Vector3 | null): void {
        this.curvePointB = this.setCurvePoint(this.curvePointB, point);
        this.updateCurveLines();
    }

    private setCurvePoint(current: WorldNode | null, point: THREE.Vector3 | null): WorldNode | null {
        if (point) {
            if (!current) {
                current = new WorldNode(point, Config.editor.curveNodeColor);
                current.parent = this;
                this.mesh.add(current.mesh);
            } else {
                current.parent = this;
                current.update(point);
            }
            return current;
        }
        if (current) {
            this.mesh.remove(current.mesh);
            current.dispose();
        }
        return null;
    }

    public override update(): void {
        this.updateCurveLines();
        super.update();
        if (this.style === 'plane') {
            const index = this.getGroupNames().indexOf('fence');
            const materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
            const material = materials[index] as THREE.MeshStandardMaterial | undefined;
            if (material) material.side = THREE.DoubleSide;
        }
    }

    private getPathPoints(divisionsOverride?: number): THREE.Vector3[] {
        return sampleCubicBezier(
            this.nodeA.mesh.position,
            this.curvePointA?.mesh.position ?? this.nodeA.mesh.position,
            this.curvePointB?.mesh.position ?? this.nodeB.mesh.position,
            this.nodeB.mesh.position,
            divisionsOverride ?? this._divisions,
        );
    }

    public getPostPositions(divisionsOverride?: number): THREE.Vector3[] {
        const points = this.getPathPoints(divisionsOverride);
        if (points.length < 2) return points.map((point) => point.clone());
        const spacing = Math.max(0.1, this.postSpacing);
        const threshold = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(this.maxAngleStep, 1, 180));
        const cumulative = [0];
        for (let i = 1; i < points.length; i++) {
            cumulative.push(cumulative[i - 1] + points[i].distanceTo(points[i - 1]));
        }
        const total = cumulative[cumulative.length - 1];
        const distances = new Set<number>([0, total]);
        for (let distance = spacing; distance < total - 1e-6; distance += spacing) distances.add(distance);

        let accumulatedTurn = 0;
        for (let i = 1; i < points.length - 1; i++) {
            const before = points[i].clone().sub(points[i - 1]).normalize();
            const after = points[i + 1].clone().sub(points[i]).normalize();
            accumulatedTurn += before.angleTo(after);
            if (accumulatedTurn + 1e-6 >= threshold) {
                distances.add(cumulative[i]);
                accumulatedTurn = 0;
            }
        }

        return [...distances].sort((a, b) => a - b).map((distance) => this.samplePolyline(points, cumulative, distance));
    }

    private samplePolyline(points: THREE.Vector3[], cumulative: number[], distance: number): THREE.Vector3 {
        for (let i = 1; i < cumulative.length; i++) {
            if (distance > cumulative[i]) continue;
            const span = cumulative[i] - cumulative[i - 1];
            const t = span > 1e-8 ? (distance - cumulative[i - 1]) / span : 0;
            return points[i - 1].clone().lerp(points[i], t);
        }
        return points[points.length - 1].clone();
    }

    protected override getGeometry(): GeometryGroup[] {
        const lod = container.resolve(LODPreviewManager).level;
        const divisions = lod > 0 ? getDivisionsForLOD(this._divisions, lod) : undefined;
        return this.buildGeometry(divisions, false);
    }

    public getExportGeometry(lodIndex: number): GeometryGroup[] {
        // OBJ/engine materials may cull backfaces, so only the exported plane needs
        // explicit reverse triangles. The editor uses one quad with DoubleSide to
        // avoid coplanar transparent triangles fighting each other.
        return this.buildGeometry(getDivisionsForLOD(this._divisions, lodIndex), true);
    }

    private buildGeometry(divisionsOverride?: number, includePlaneBackFaces = false): GeometryGroup[] {
        const path = this.getPathPoints(divisionsOverride);
        const panel: Triangle[] = [];
        let distance = 0;
        for (let i = 1; i < path.length; i++) {
            const start = path[i - 1];
            const end = path[i];
            const length = start.distanceTo(end);
            if (length < 1e-6) continue;
            if (this.style === 'plane') this.addPlanePanel(panel, start, end, distance, distance + length, includePlaneBackFaces);
            else this.addBox(panel, start, end, 0, Math.max(0.05, this.height), Math.max(0.01, this.thickness));
            distance += length;
        }

        const posts: Triangle[] = [];
        for (const position of this.getPostPositions(divisionsOverride)) this.addPost(posts, position);
        this.applyUV('fence', panel);
        this.applyUV('posts', posts);
        return [{ name: 'fence', triangles: panel }, { name: 'posts', triangles: posts }];
    }

    private addPlanePanel(out: Triangle[], start: THREE.Vector3, end: THREE.Vector3, u0: number, u1: number, includeBackFace: boolean): void {
        const height = Math.max(0.05, this.height);
        const a = start.clone();
        const b = end.clone();
        const c = end.clone().addScaledVector(UP, height);
        const d = start.clone().addScaledVector(UP, height);
        this.addQuad(out, a, b, c, d,
            new THREE.Vector2(u0, 0), new THREE.Vector2(u1, 0),
            new THREE.Vector2(u1, 1), new THREE.Vector2(u0, 1));
        if (includeBackFace) {
            this.addQuad(out, b, a, d, c,
                new THREE.Vector2(u1, 0), new THREE.Vector2(u0, 0),
                new THREE.Vector2(u0, 1), new THREE.Vector2(u1, 1));
        }
    }

    private addBox(out: Triangle[], start: THREE.Vector3, end: THREE.Vector3, bottom: number, top: number, width: number): void {
        const direction = end.clone().sub(start);
        const length = direction.length();
        if (length < 1e-6) return;
        direction.normalize();
        const right = new THREE.Vector3().crossVectors(direction, UP).normalize().multiplyScalar(width / 2);
        const corners = [
            start.clone().sub(right).addScaledVector(UP, bottom),
            start.clone().add(right).addScaledVector(UP, bottom),
            end.clone().add(right).addScaledVector(UP, bottom),
            end.clone().sub(right).addScaledVector(UP, bottom),
            start.clone().sub(right).addScaledVector(UP, top),
            start.clone().add(right).addScaledVector(UP, top),
            end.clone().add(right).addScaledVector(UP, top),
            end.clone().sub(right).addScaledVector(UP, top),
        ];
        // Vertical panel faces always span V 0..1 regardless of authored height.
        // This keeps a fence texture fitted once from bottom to top while U can still
        // repeat along its physical length.
        this.addQuadSimple(out, corners[3], corners[0], corners[4], corners[7], length, 1);
        this.addQuadSimple(out, corners[1], corners[2], corners[6], corners[5], length, 1);
        this.addQuadSimple(out, corners[2], corners[3], corners[7], corners[6], width, 1);
        this.addQuadSimple(out, corners[0], corners[1], corners[5], corners[4], width, 1);
        this.addQuadSimple(out, corners[7], corners[4], corners[5], corners[6], length, width);
        this.addQuadSimple(out, corners[1], corners[0], corners[3], corners[2], length, width);
    }

    private addPost(out: Triangle[], center: THREE.Vector3): void {
        const sides = this.postShape === 'box' ? 4 : Math.max(3, Math.round(this.postSides));
        const radius = Math.max(0.02, this.postWidth) / 2;
        const height = Math.max(0.05, this.postHeight);
        const bottom: THREE.Vector3[] = [];
        const top: THREE.Vector3[] = [];
        for (let i = 0; i < sides; i++) {
            const angle = (i / sides) * Math.PI * 2 + (this.postShape === 'box' ? Math.PI / 4 : 0);
            const offset = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
            bottom.push(center.clone().add(offset));
            top.push(center.clone().add(offset).addScaledVector(UP, height));
        }
        for (let i = 0; i < sides; i++) {
            const next = (i + 1) % sides;
            // Ring points run counter-clockwise from above. Use the reverse order on
            // side walls so their normals point away from the post, then use upward
            // winding for the cap and downward winding for the base.
            this.addQuadSimple(out, bottom[next], bottom[i], top[i], top[next], (Math.PI * 2 * radius) / sides, height);
            out.push(new Triangle(top[next], top[i], center.clone().addScaledVector(UP, height)));
            out.push(new Triangle(bottom[i], bottom[next], center.clone()));
        }
    }

    private addQuadSimple(out: Triangle[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, width: number, height: number): void {
        this.addQuad(out, a, b, c, d,
            new THREE.Vector2(0, 0), new THREE.Vector2(width, 0),
            new THREE.Vector2(width, height), new THREE.Vector2(0, height));
    }

    private addQuad(out: Triangle[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uvA: THREE.Vector2, uvB: THREE.Vector2, uvC: THREE.Vector2, uvD: THREE.Vector2): void {
        // Never share mutable Vector2 instances between triangles. UV transforms are
        // applied in-place later; shared diagonal coordinates would otherwise be
        // scaled twice and distort exactly one half of the quad when Stretch != 1.
        out.push(new Triangle(a, b, c, uvA.clone(), uvB.clone(), uvC.clone()));
        out.push(new Triangle(a, c, d, uvA.clone(), uvC.clone(), uvD.clone()));
    }

    private applyUV(group: FenceGroup, triangles: Triangle[]): void {
        const transform = this.uvTransforms.get(group)!;
        for (const tri of triangles) {
            for (const uv of [tri.uvA, tri.uvB, tri.uvC]) {
                uv.set(uv.x * transform.scaleX + transform.offsetX, uv.y * transform.scaleY + transform.offsetY);
            }
        }
    }

    public override getUVGroups(): string[] { return ['fence', 'posts']; }
    public override getUVTransform(group: string): UVTransform {
        const value = this.uvTransforms.get(group as FenceGroup);
        return value ? { ...value } : super.getUVTransform(group);
    }
    public override setUVTransform(group: string, value: UVTransform): void {
        if (!this.uvTransforms.has(group as FenceGroup)) return;
        this.uvTransforms.set(group as FenceGroup, {
            offsetX: Number.isFinite(value.offsetX) ? value.offsetX : 0,
            offsetY: Number.isFinite(value.offsetY) ? value.offsetY : 0,
            scaleX: Number.isFinite(value.scaleX) ? Math.max(0.1, value.scaleX) : 1,
            scaleY: Number.isFinite(value.scaleY) ? Math.max(0.1, value.scaleY) : 1,
        });
        this.update();
    }

    public override getNodeBasis(index: number): NodeBasis {
        const points = this.getPathPoints();
        const last = points.length - 1;
        const forward = index === 0
            ? points[1].clone().sub(points[0]).normalize()
            : points[last].clone().sub(points[last - 1]).normalize();
        const right = new THREE.Vector3().crossVectors(forward, UP).normalize();
        return { forward, right, up: UP.clone() };
    }

    public override getOccupiedArea(): OccupiedTriangle[] { return []; }
    public override cutsTerrainSurface(): boolean { return false; }

    public override getProperties(): PropertyDefinition {
        const self = this;
        const nodeProperty = (label: string, node: WorldNode): SectionItem => ({
            type: 'vector3', label, get: () => node.mesh.position.clone(), set: (value) => { node.update(value); self.update(); },
        });
        const sections = [
            { label: 'Nodes', properties: [nodeProperty('Node A', this.nodeA), nodeProperty('Node B', this.nodeB)] },
            { label: 'Fence', properties: [
                { type: 'number' as const, label: 'Divisions', get: () => self.divisions, set: (v: number) => { self.divisions = v; self.update(); }, min: 0, max: 64, step: 1 },
                { type: 'select' as const, label: 'Style', options: [{ label: 'Double-Sided Plane', value: 'plane' }, { label: 'Box', value: 'box' }], get: () => self.style, set: (v: string) => { self.style = v === 'box' ? 'box' : 'plane'; self.update(); self.onPropertiesChanged?.(); } },
                { type: 'number' as const, label: 'Height', get: () => self.height, set: (v: number) => { self.height = Math.max(0.05, v); self.update(); }, min: 0.05, step: 0.05 },
                { type: 'number' as const, label: 'Texture Stretch', get: () => self.uvTransforms.get('fence')!.scaleX, set: (v: number) => { const uv = self.uvTransforms.get('fence')!; self.setUVTransform('fence', { ...uv, scaleX: Math.max(0.01, v) }); }, min: 0.01, step: 0.1 },
                ...(self.style === 'box' ? [{ type: 'number' as const, label: 'Thickness', get: () => self.thickness, set: (v: number) => { self.thickness = Math.max(0.01, v); self.update(); }, min: 0.01, step: 0.01 }] : []),
            ] },
            { label: 'Posts', properties: [
                { type: 'number' as const, label: 'Spacing', get: () => self.postSpacing, set: (v: number) => { self.postSpacing = Math.max(0.1, v); self.update(); }, min: 0.1, step: 0.1 },
                { type: 'number' as const, label: 'Max Angle Step', get: () => self.maxAngleStep, set: (v: number) => { self.maxAngleStep = THREE.MathUtils.clamp(v, 1, 180); self.update(); }, min: 1, max: 180, step: 1 },
                { type: 'number' as const, label: 'Post Height', get: () => self.postHeight, set: (v: number) => { self.postHeight = Math.max(0.05, v); self.update(); }, min: 0.05, step: 0.05 },
                { type: 'number' as const, label: 'Post Width', get: () => self.postWidth, set: (v: number) => { self.postWidth = Math.max(0.04, v); self.update(); }, min: 0.04, step: 0.01 },
                { type: 'select' as const, label: 'Post Shape', options: [{ label: 'Box', value: 'box' }, { label: 'Circle', value: 'circle' }], get: () => self.postShape, set: (v: string) => { self.postShape = v === 'circle' ? 'circle' : 'box'; self.update(); self.onPropertiesChanged?.(); } },
                ...(self.postShape === 'circle' ? [{ type: 'number' as const, label: 'Circle Sides', get: () => self.postSides, set: (v: number) => { self.postSides = Math.max(3, Math.round(v)); self.update(); }, min: 3, max: 64, step: 1 }] : []),
            ] },
        ];
        return { title: 'Fence', icon: '&#9783;', sections };
    }

    public override serialize(id: number): ElementData {
        const { textures, textureRotations } = this.collectTextureMaps();
        const curveA = this.curvePointA?.mesh.position;
        const curveB = this.curvePointB?.mesh.position;
        return {
            type: 'fence', id,
            nodes: [this.nodeA.mesh.position, this.nodeB.mesh.position].map((p) => ({ x: p.x, y: p.y, z: p.z })),
            textures, textureRotations,
            uvTransforms: Object.fromEntries([...this.uvTransforms].map(([name, value]) => [name, { ...value }])),
            divisions: this.divisions,
            curvePointA: curveA ? { x: curveA.x, y: curveA.y, z: curveA.z } : null,
            curvePointB: curveB ? { x: curveB.x, y: curveB.y, z: curveB.z } : null,
            fenceStyle: this.style,
            fenceHeight: this.height,
            fenceThickness: this.thickness,
            fencePostSpacing: this.postSpacing,
            fencePostHeight: this.postHeight,
            fencePostWidth: this.postWidth,
            fencePostShape: this.postShape,
            fencePostSides: this.postSides,
            fenceMaxAngleStep: this.maxAngleStep,
        };
    }

    public static deserialize(data: ElementData): Fence {
        const a = data.nodes[0] ?? { x: 0, y: 0, z: 0 };
        const b = data.nodes[1] ?? { x: 1, y: 0, z: 0 };
        const fence = new Fence(new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z));
        fence.style = data.fenceStyle === 'box' ? 'box' : 'plane';
        fence.height = Math.max(0.05, data.fenceHeight ?? 1.5);
        fence.thickness = Math.max(0.01, data.fenceThickness ?? 0.08);
        fence.postSpacing = Math.max(0.1, data.fencePostSpacing ?? 2);
        fence.postHeight = Math.max(0.05, data.fencePostHeight ?? 1.8);
        fence.postWidth = Math.max(0.04, data.fencePostWidth ?? 0.14);
        fence.postShape = data.fencePostShape === 'circle' ? 'circle' : 'box';
        fence.postSides = Math.max(3, Math.round(data.fencePostSides ?? 12));
        fence.maxAngleStep = THREE.MathUtils.clamp(data.fenceMaxAngleStep ?? 30, 1, 180);
        for (const [group, transform] of Object.entries(data.uvTransforms ?? {})) {
            if (fence.uvTransforms.has(group as FenceGroup)) fence.uvTransforms.set(group as FenceGroup, { ...transform });
        }
        if (data.divisions && data.divisions > 0) {
            fence.divisions = data.divisions;
            if (data.curvePointA) fence.setCurvePointA(new THREE.Vector3(data.curvePointA.x, data.curvePointA.y, data.curvePointA.z));
            if (data.curvePointB) fence.setCurvePointB(new THREE.Vector3(data.curvePointB.x, data.curvePointB.y, data.curvePointB.z));
        }
        return fence;
    }

    private updateCurveLines(): void {
        this.disposeCurveLines();
        if (this._divisions <= 0) return;
        this.curveLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(this.getPathPoints()),
            new THREE.LineBasicMaterial({ color: Config.editor.curveNodeColor }),
        );
        this.mesh.add(this.curveLine);
        if (this.curvePointA && this.curvePointB) {
            this.handleLineA = this.makeHandleLine(this.nodeA.mesh.position, this.curvePointA.mesh.position);
            this.handleLineB = this.makeHandleLine(this.nodeB.mesh.position, this.curvePointB.mesh.position);
            this.mesh.add(this.handleLineA, this.handleLineB);
        }
    }

    private makeHandleLine(a: THREE.Vector3, b: THREE.Vector3): THREE.Line {
        return new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([a, b]),
            new THREE.LineBasicMaterial({ color: Config.editor.curveNodeColor }),
        );
    }

    private disposeCurveLines(): void {
        for (const line of [this.curveLine, this.handleLineA, this.handleLineB]) {
            if (!line) continue;
            this.mesh.remove(line);
            line.geometry.dispose();
            (line.material as THREE.Material).dispose();
        }
        this.curveLine = this.handleLineA = this.handleLineB = null;
    }

    public override dispose(): void {
        this.disposeCurveLines();
        super.dispose();
    }
}
