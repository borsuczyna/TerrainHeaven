import * as THREE from 'three';
import { container } from 'tsyringe';
import WorldElement, {
    type ConnectionProfile,
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
import LODPreviewManager from '../editor/LODPreviewManager';

export type StairsRailingSide = 'none' | 'left' | 'right' | 'both';
type StairsGroup = 'steps' | 'railings';

const UP = new THREE.Vector3(0, 1, 0);
const MIN_RUN = 0.1;
const MIN_RISE = 0.1;
const LOD_STEP_DIVISORS = [1, 2, 4, 8];
const LOD_POST_MULTIPLIERS = [1, 1.5, 2.5, 4];

/** A compact closed stair prism with optional low-poly handrails. */
export default class Stairs extends WorldElement {
    public get nodeA(): WorldNode { return this.nodes[0]; }
    public get nodeB(): WorldNode { return this.nodes[1]; }

    public width = 3;
    public stepCount = 12;
    public foundationDepth = 0.15;
    public railingSide: StairsRailingSide = 'both';
    public railingHeight = 1.05;
    public railingThickness = 0.08;
    public railingPostSpacing = 1.5;
    public midRail = true;
    public cutTerrain = true;

    private readonly uvTransforms = new Map<StairsGroup, UVTransform>([
        ['steps', { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 }],
        ['railings', { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 }],
    ]);

    constructor(bottom: THREE.Vector3, top: THREE.Vector3) {
        super();
        const safeTop = top.clone();
        if (safeTop.y < bottom.y + MIN_RISE) safeTop.y = bottom.y + 3;
        this.setNode(0, new WorldNode(bottom.clone(), Config.editor.nodeColor));
        this.setNode(1, new WorldNode(safeTop, Config.editor.nodeColor));
        this.mesh.castShadow = true;
    }

    public override update(): void {
        this.width = Math.max(0.2, this.width);
        this.stepCount = THREE.MathUtils.clamp(Math.round(this.stepCount), 1, 128);
        this.foundationDepth = Math.max(0.02, this.foundationDepth);
        this.railingHeight = Math.max(0.2, this.railingHeight);
        this.railingThickness = THREE.MathUtils.clamp(this.railingThickness, 0.02, Math.max(0.02, this.width * 0.25));
        this.railingPostSpacing = Math.max(0.25, this.railingPostSpacing);
        if (this.nodeB.mesh.position.y < this.nodeA.mesh.position.y + MIN_RISE) {
            this.nodeB.mesh.position.y = this.nodeA.mesh.position.y + MIN_RISE;
        }
        super.update();
        this.applyDefaultMaterialColors();
    }

    protected override getGeometry(): GeometryGroup[] {
        return this.buildGeometry(container.resolve(LODPreviewManager).level);
    }

    public getExportGeometry(lodIndex: number): GeometryGroup[] {
        return this.buildGeometry(lodIndex);
    }

    private buildGeometry(lodIndex: number): GeometryGroup[] {
        const frame = this.getFrame();
        if (!frame) return [{ name: 'steps', triangles: [] }, { name: 'railings', triangles: [] }];

        const lod = THREE.MathUtils.clamp(Math.round(lodIndex), 0, LOD_STEP_DIVISORS.length - 1);
        const steps = Math.max(1, Math.ceil(this.stepCount / LOD_STEP_DIVISORS[lod]));
        const stepTriangles: Triangle[] = [];
        const railTriangles: Triangle[] = [];
        const baseY = frame.bottom.y - this.foundationDepth;
        const halfWidth = this.width / 2;
        const stepDepth = frame.run / steps;
        const stepRise = frame.rise / steps;

        for (let index = 0; index < steps; index++) {
            const distance0 = index * stepDepth;
            const distance1 = (index + 1) * stepDepth;
            const topY = frame.bottom.y + (index + 1) * stepRise;
            const previousY = index === 0 ? baseY : frame.bottom.y + index * stepRise;
            const startLeft = this.framePoint(frame, distance0, -halfWidth, topY);
            const startRight = this.framePoint(frame, distance0, halfWidth, topY);
            const endLeft = this.framePoint(frame, distance1, -halfWidth, topY);
            const endRight = this.framePoint(frame, distance1, halfWidth, topY);

            this.addQuadFacing(stepTriangles, startLeft, startRight, endRight, endLeft, UP, this.width, stepDepth);
            this.addQuadFacing(
                stepTriangles,
                this.framePoint(frame, distance0, -halfWidth, previousY),
                this.framePoint(frame, distance0, halfWidth, previousY),
                startRight,
                startLeft,
                frame.forward.clone().negate(),
                this.width,
                Math.max(0.001, topY - previousY),
            );
            this.addQuadFacing(
                stepTriangles,
                this.framePoint(frame, distance1, -halfWidth, baseY),
                this.framePoint(frame, distance0, -halfWidth, baseY),
                startLeft,
                endLeft,
                frame.right.clone().negate(),
                stepDepth,
                topY - baseY,
            );
            this.addQuadFacing(
                stepTriangles,
                this.framePoint(frame, distance0, halfWidth, baseY),
                this.framePoint(frame, distance1, halfWidth, baseY),
                endRight,
                startRight,
                frame.right,
                stepDepth,
                topY - baseY,
            );
        }

        this.addQuadFacing(
            stepTriangles,
            this.framePoint(frame, frame.run, -halfWidth, baseY),
            this.framePoint(frame, frame.run, -halfWidth, frame.top.y),
            this.framePoint(frame, frame.run, halfWidth, frame.top.y),
            this.framePoint(frame, frame.run, halfWidth, baseY),
            frame.forward,
            this.width,
            frame.top.y - baseY,
        );
        this.addQuadFacing(
            stepTriangles,
            this.framePoint(frame, 0, -halfWidth, baseY),
            this.framePoint(frame, frame.run, -halfWidth, baseY),
            this.framePoint(frame, frame.run, halfWidth, baseY),
            this.framePoint(frame, 0, halfWidth, baseY),
            UP.clone().negate(),
            frame.run,
            this.width,
        );

        if (this.railingSide === 'left' || this.railingSide === 'both') {
            this.addRailing(railTriangles, frame, -halfWidth + this.railingThickness * 0.5, steps, lod);
        }
        if (this.railingSide === 'right' || this.railingSide === 'both') {
            this.addRailing(railTriangles, frame, halfWidth - this.railingThickness * 0.5, steps, lod);
        }

        this.applyUV('steps', stepTriangles);
        this.applyUV('railings', railTriangles);
        return [{ name: 'steps', triangles: stepTriangles }, { name: 'railings', triangles: railTriangles }];
    }

    private addRailing(out: Triangle[], frame: StairFrame, side: number, steps: number, lod: number): void {
        const spacing = this.railingPostSpacing * LOD_POST_MULTIPLIERS[lod];
        const segmentCount = Math.max(1, Math.min(256, Math.ceil(frame.run / spacing)));
        const thickness = this.railingThickness;
        const firstTreadY = frame.bottom.y + frame.rise / steps;
        const railStart = this.framePoint(frame, 0, side, firstTreadY + this.railingHeight);
        const railEnd = this.framePoint(frame, frame.run, side, frame.top.y + this.railingHeight);

        for (let index = 0; index <= segmentCount; index++) {
            const distance = frame.run * index / segmentCount;
            const stepIndex = Math.min(steps - 1, Math.floor(distance / frame.run * steps));
            const surfaceY = frame.bottom.y + (stepIndex + 1) * frame.rise / steps;
            const railY = THREE.MathUtils.lerp(railStart.y, railEnd.y, distance / frame.run);
            const base = this.framePoint(frame, distance, side, surfaceY);
            const top = this.framePoint(frame, distance, side, railY);
            this.addBeam(out, base, top, thickness, frame.right);
        }

        this.addBeam(out, railStart, railEnd, thickness, frame.right);
        if (this.midRail && lod < 3) {
            const offset = this.railingHeight * 0.48;
            this.addBeam(
                out,
                railStart.clone().addScaledVector(UP, -offset),
                railEnd.clone().addScaledVector(UP, -offset),
                thickness * 0.8,
                frame.right,
            );
        }
    }

    private addBeam(out: Triangle[], start: THREE.Vector3, end: THREE.Vector3, size: number, lateralHint: THREE.Vector3): void {
        const axis = end.clone().sub(start);
        const length = axis.length();
        if (length < 1e-6) return;
        axis.normalize();
        const side = lateralHint.clone().addScaledVector(axis, -lateralHint.dot(axis));
        if (side.lengthSq() < 1e-8) side.set(1, 0, 0).addScaledVector(axis, -axis.x);
        side.normalize();
        const normal = new THREE.Vector3().crossVectors(axis, side).normalize();
        const half = size / 2;
        const corner = (center: THREE.Vector3, sideSign: number, normalSign: number): THREE.Vector3 => center.clone()
            .addScaledVector(side, sideSign * half)
            .addScaledVector(normal, normalSign * half);
        const a0 = corner(start, -1, -1); const a1 = corner(start, 1, -1);
        const a2 = corner(start, 1, 1); const a3 = corner(start, -1, 1);
        const b0 = corner(end, -1, -1); const b1 = corner(end, 1, -1);
        const b2 = corner(end, 1, 1); const b3 = corner(end, -1, 1);
        this.addQuadFacing(out, a0, a3, a2, a1, axis.clone().negate(), size, size);
        this.addQuadFacing(out, b0, b1, b2, b3, axis, size, size);
        this.addQuadFacing(out, a0, a1, b1, b0, normal.clone().negate(), length, size);
        this.addQuadFacing(out, a1, a2, b2, b1, side, length, size);
        this.addQuadFacing(out, a2, a3, b3, b2, normal, length, size);
        this.addQuadFacing(out, a3, a0, b0, b3, side.clone().negate(), length, size);
    }

    private addQuadFacing(
        out: Triangle[],
        a: THREE.Vector3,
        b: THREE.Vector3,
        c: THREE.Vector3,
        d: THREE.Vector3,
        outward: THREE.Vector3,
        width: number,
        height: number,
    ): void {
        const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
        let points = [a, b, c, d];
        if (normal.dot(outward) < 0) points = [a, d, c, b];
        const uvA = new THREE.Vector2(0, 0);
        const uvB = new THREE.Vector2(width, 0);
        const uvC = new THREE.Vector2(width, height);
        const uvD = new THREE.Vector2(0, height);
        out.push(new Triangle(points[0], points[1], points[2], uvA.clone(), uvB.clone(), uvC.clone()));
        out.push(new Triangle(points[0], points[2], points[3], uvA.clone(), uvC.clone(), uvD.clone()));
    }

    private getFrame(): StairFrame | null {
        const bottom = this.nodeA.mesh.position;
        const top = this.nodeB.mesh.position;
        const horizontal = new THREE.Vector3(top.x - bottom.x, 0, top.z - bottom.z);
        const run = horizontal.length();
        if (run < MIN_RUN) return null;
        const forward = horizontal.divideScalar(run);
        const right = new THREE.Vector3().crossVectors(forward, UP).normalize();
        return { bottom, top, forward, right, run, rise: Math.max(MIN_RISE, top.y - bottom.y) };
    }

    private framePoint(frame: StairFrame, distance: number, side: number, y: number): THREE.Vector3 {
        return frame.bottom.clone().addScaledVector(frame.forward, distance).addScaledVector(frame.right, side).setY(y);
    }

    private applyUV(group: StairsGroup, triangles: Triangle[]): void {
        const transform = this.uvTransforms.get(group)!;
        for (const triangle of triangles) {
            for (const uv of [triangle.uvA, triangle.uvB, triangle.uvC]) {
                uv.set(uv.x * transform.scaleX + transform.offsetX, uv.y * transform.scaleY + transform.offsetY);
            }
        }
    }

    private applyDefaultMaterialColors(): void {
        const materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
        const colors: Record<StairsGroup, number> = { steps: 0x8b8377, railings: 0x30353a };
        this.getGroupNames().forEach((name, index) => {
            const material = materials[index] as THREE.MeshStandardMaterial | undefined;
            if (!material || material.map || !(name in colors)) return;
            const base = new THREE.Color(colors[name as StairsGroup]);
            material.userData.baseColor = base.clone();
            material.color.copy(material.emissiveIntensity > 0 ? base.clone().lerp(new THREE.Color(0x4d8dff), 0.45) : base);
            material.needsUpdate = true;
        });
    }

    public override getNodeBasis(_index: number): NodeBasis {
        const frame = this.getFrame();
        return frame
            ? { forward: frame.forward.clone(), right: frame.right.clone(), up: UP.clone() }
            : { forward: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(0, 0, 1), up: UP.clone() };
    }

    public override getWidth(): number { return this.width; }
    public override getFixedConnectionProfile(_index: number): ConnectionProfile {
        return { halfWidth: this.width / 2, sidewalkWidth: 0, curbHeight: 0 };
    }

    public override cutsTerrainSurface(): boolean { return this.cutTerrain; }

    public override getOccupiedArea(): OccupiedTriangle[] {
        const frame = this.getFrame();
        if (!frame) return [];
        const half = this.width / 2;
        const bottomLeft = this.framePoint(frame, 0, -half, frame.bottom.y);
        const bottomRight = this.framePoint(frame, 0, half, frame.bottom.y);
        const topLeft = this.framePoint(frame, frame.run, -half, frame.top.y);
        const topRight = this.framePoint(frame, frame.run, half, frame.top.y);
        return [
            { a: bottomLeft, b: bottomRight, c: topRight, bankSlopeDegrees: 70 },
            { a: bottomLeft.clone(), b: topRight.clone(), c: topLeft, bankSlopeDegrees: 70 },
        ];
    }

    public override getUVGroups(): string[] { return ['steps', 'railings']; }
    public override getUVTransform(group: string): UVTransform {
        const transform = this.uvTransforms.get(group as StairsGroup);
        return transform ? { ...transform } : super.getUVTransform(group);
    }
    public override setUVTransform(group: string, transform: UVTransform): void {
        if (!this.uvTransforms.has(group as StairsGroup)) return;
        this.uvTransforms.set(group as StairsGroup, {
            offsetX: Number.isFinite(transform.offsetX) ? transform.offsetX : 0,
            offsetY: Number.isFinite(transform.offsetY) ? transform.offsetY : 0,
            scaleX: Number.isFinite(transform.scaleX) ? Math.max(0.05, transform.scaleX) : 1,
            scaleY: Number.isFinite(transform.scaleY) ? Math.max(0.05, transform.scaleY) : 1,
        });
        this.update();
    }

    public override getProperties(): PropertyDefinition {
        const self = this;
        const nodeSection = (label: string, node: WorldNode, index: number) => {
            const properties: SectionItem[] = [{
                type: 'vector3', label: 'Position', get: () => node.mesh.position.clone(),
                set: (value) => { node.update(value); self.update(); },
            }];
            if (this.isConnected(index)) properties.push({
                type: 'button', label: 'Disconnect', onClick: () => { self.disconnect(index); self.onPropertiesChanged?.(); },
            });
            return { label, properties };
        };
        const sections = [
            nodeSection('Bottom', this.nodeA, 0),
            nodeSection('Top', this.nodeB, 1),
            { label: 'Stairs', properties: [
                { type: 'number' as const, label: 'Width', get: () => self.width, set: (value: number) => { self.width = Math.max(0.2, value); self.update(); }, min: 0.2, step: 0.1 },
                { type: 'number' as const, label: 'Rise', get: () => self.nodeB.mesh.position.y - self.nodeA.mesh.position.y, set: (value: number) => { self.nodeB.mesh.position.y = self.nodeA.mesh.position.y + Math.max(MIN_RISE, value); self.update(); }, min: MIN_RISE, step: 0.1 },
                { type: 'number' as const, label: 'Run Length', get: () => self.getFrame()?.run ?? 0, set: (value: number) => self.setRunLength(value), min: MIN_RUN, step: 0.1 },
                { type: 'number' as const, label: 'Step Count', get: () => self.stepCount, set: (value: number) => { self.stepCount = Math.max(1, Math.round(value)); self.update(); }, min: 1, max: 128, step: 1 },
                { type: 'number' as const, label: 'Foundation Depth', get: () => self.foundationDepth, set: (value: number) => { self.foundationDepth = Math.max(0.02, value); self.update(); }, min: 0.02, step: 0.05 },
                { type: 'boolean' as const, label: 'Cut Terrain', get: () => self.cutTerrain, set: (value: boolean) => { self.cutTerrain = value; self.update(); } },
                { type: 'button' as const, label: 'Flip Direction', onClick: () => self.flipDirection() },
            ] },
            { label: 'Railings', properties: [
                { type: 'select' as const, label: 'Sides', options: [
                    { label: 'None', value: 'none' }, { label: 'Left', value: 'left' },
                    { label: 'Right', value: 'right' }, { label: 'Both', value: 'both' },
                ], get: () => self.railingSide, set: (value: string) => { self.railingSide = Stairs.isRailingSide(value) ? value : 'both'; self.update(); self.onPropertiesChanged?.(); } },
                ...(self.railingSide !== 'none' ? [
                    { type: 'number' as const, label: 'Height', get: () => self.railingHeight, set: (value: number) => { self.railingHeight = Math.max(0.2, value); self.update(); }, min: 0.2, step: 0.05 },
                    { type: 'number' as const, label: 'Thickness', get: () => self.railingThickness, set: (value: number) => { self.railingThickness = Math.max(0.02, value); self.update(); }, min: 0.02, step: 0.01 },
                    { type: 'number' as const, label: 'Post Spacing', get: () => self.railingPostSpacing, set: (value: number) => { self.railingPostSpacing = Math.max(0.25, value); self.update(); }, min: 0.25, step: 0.1 },
                    { type: 'boolean' as const, label: 'Mid Rail', get: () => self.midRail, set: (value: boolean) => { self.midRail = value; self.update(); } },
                ] : []),
            ] },
        ];
        return { title: 'Stairs', icon: '&#x25E9;', sections };
    }

    private setRunLength(value: number): void {
        const frame = this.getFrame();
        const direction = frame?.forward ?? new THREE.Vector3(1, 0, 0);
        const length = Math.max(MIN_RUN, value);
        this.nodeB.mesh.position.x = this.nodeA.mesh.position.x + direction.x * length;
        this.nodeB.mesh.position.z = this.nodeA.mesh.position.z + direction.z * length;
        this.update();
    }

    private flipDirection(): void {
        const bottom = this.nodeA.mesh.position.clone();
        const top = this.nodeB.mesh.position.clone();
        const rise = top.y - bottom.y;
        this.nodeA.mesh.position.set(top.x, bottom.y, top.z);
        this.nodeB.mesh.position.set(bottom.x, bottom.y + rise, bottom.z);
        this.update();
    }

    public override serialize(id: number): ElementData {
        const { textures, textureRotations } = this.collectTextureMaps();
        return {
            type: 'stairs', id,
            nodes: [this.nodeA.mesh.position, this.nodeB.mesh.position].map((point) => ({ x: point.x, y: point.y, z: point.z })),
            textures, textureRotations,
            uvTransforms: Object.fromEntries([...this.uvTransforms].map(([name, value]) => [name, { ...value }])),
            stairsWidth: this.width,
            stairsStepCount: this.stepCount,
            stairsFoundationDepth: this.foundationDepth,
            stairsRailingSide: this.railingSide,
            stairsRailingHeight: this.railingHeight,
            stairsRailingThickness: this.railingThickness,
            stairsRailingPostSpacing: this.railingPostSpacing,
            stairsMidRail: this.midRail,
            stairsCutTerrain: this.cutTerrain,
        };
    }

    public static deserialize(data: ElementData): Stairs {
        const bottom = data.nodes[0] ?? { x: 0, y: 0, z: 0 };
        const top = data.nodes[1] ?? { x: 4, y: 3, z: 0 };
        const stairs = new Stairs(
            new THREE.Vector3(bottom.x, bottom.y, bottom.z),
            new THREE.Vector3(top.x, top.y, top.z),
        );
        stairs.width = Math.max(0.2, data.stairsWidth ?? 3);
        stairs.stepCount = THREE.MathUtils.clamp(Math.round(data.stairsStepCount ?? 12), 1, 128);
        stairs.foundationDepth = Math.max(0.02, data.stairsFoundationDepth ?? 0.15);
        stairs.railingSide = Stairs.isRailingSide(data.stairsRailingSide) ? data.stairsRailingSide : 'both';
        stairs.railingHeight = Math.max(0.2, data.stairsRailingHeight ?? 1.05);
        stairs.railingThickness = Math.max(0.02, data.stairsRailingThickness ?? 0.08);
        stairs.railingPostSpacing = Math.max(0.25, data.stairsRailingPostSpacing ?? 1.5);
        stairs.midRail = data.stairsMidRail ?? true;
        stairs.cutTerrain = data.stairsCutTerrain ?? true;
        for (const [group, transform] of Object.entries(data.uvTransforms ?? {})) {
            if (stairs.uvTransforms.has(group as StairsGroup)) stairs.uvTransforms.set(group as StairsGroup, { ...transform });
        }
        return stairs;
    }

    private static isRailingSide(value: unknown): value is StairsRailingSide {
        return value === 'none' || value === 'left' || value === 'right' || value === 'both';
    }
}

interface StairFrame {
    bottom: THREE.Vector3;
    top: THREE.Vector3;
    forward: THREE.Vector3;
    right: THREE.Vector3;
    run: number;
    rise: number;
}
