import * as THREE from 'three';
import { container } from 'tsyringe';
import WorldElement, { type NodeBasis, type GeometryGroup, type ElementData, type OccupiedTriangle } from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import { sampleCubicBezier } from '../utils/Bezier';
import type { PropertyDefinition } from '../editor/Properties';
import type { TerrainCutPointInput } from '../terrain/TerrainMesher';
import LODPreviewManager from '../editor/LODPreviewManager';
import { getDetailLevelForLOD, getDivisionsForLOD } from '../export/LODLevels';

const WATER_COLOR = 0x2f6fa8;
const WATER_SURFACE_OFFSET = 0.025;
// How far past 1 Irregularity can be pushed. Values above 1 make the bank noise read as
// sharp corners rather than a gentle wander; the formulas below stay slope-safe and keep
// a minimum channel width at any value up to this cap.
const MAX_IRREGULARITY = 3;

// A river works like a Road: nodes, curve points, Divisions, connectable ends and adjustable
// width. Its water is an overlay; unlike roads it keeps the terrain surface intact below it.
export default class RiverSpline extends WorldElement {
    public get nodeA(): WorldNode { return this.nodes[0]; }
    public get nodeB(): WorldNode { return this.nodes[1]; }

    public width: number = 4;
    public override cutsTerrainSurface(): boolean { return false; }
    // How steeply the surrounding terrain drops down to meet the water. Higher = a narrow,
    // steep-banked channel; lower = a wide, gently sloped valley.
    public bankSlope: number = 70;
    // Rounds the transition at the riverbed and terrain edge. 0 is a straight
    // slope, 1 is fully eased while retaining the configured maximum angle.
    public bankSmoothing: number = 0.65;
    // Adds deterministic variation to the bank outline and profile - both the water's
    // own edge and the terrain around it. Because it is derived from world position it
    // does not flicker when the mesh rebuilds. Past 1 the noise increasingly folds into
    // sharp corners instead of a smooth wander.
    public irregularityLevel: number = 0;
    // Controls local river terrain sampling/remeshing without increasing the
    // detail of the entire terrain.
    public detailLevel: number = 1;

    private _divisions: number = 0;
    private curvePointA: WorldNode | null = null;
    private curvePointB: WorldNode | null = null;
    private handleLineA: THREE.Line | null = null;
    private handleLineB: THREE.Line | null = null;

    public get divisions(): number { return this._divisions; }
    public set divisions(value: number) {
        this._divisions = Math.max(0, Math.round(value));
        if (this._divisions > 0) {
            if (!this.curvePointA) {
                const a = this.nodeA.mesh.position;
                const b = this.nodeB.mesh.position;
                this.setCurvePointA(a.clone().lerp(b.clone(), 1 / 3));
            }
            if (!this.curvePointB) {
                const a = this.nodeA.mesh.position;
                const b = this.nodeB.mesh.position;
                this.setCurvePointB(a.clone().lerp(b.clone(), 2 / 3));
            }
        } else {
            this.setCurvePointA(null);
            this.setCurvePointB(null);
        }
        this.update();
    }

    constructor(positionA: THREE.Vector3, positionB: THREE.Vector3) {
        super();
        this.setNode(0, new WorldNode(positionA, Config.editor.riverNodeColor));
        this.setNode(1, new WorldNode(positionB, Config.editor.riverNodeColor));
    }

    public setCurvePointA(point: THREE.Vector3 | null): void {
        if (point) {
            if (!this.curvePointA) {
                this.curvePointA = new WorldNode(point, Config.editor.curveNodeColor);
                this.curvePointA.parent = this;
                this.mesh.add(this.curvePointA.mesh);
            } else {
                this.curvePointA.parent = this;
                this.curvePointA.update(point);
            }
        } else if (this.curvePointA) {
            this.mesh.remove(this.curvePointA.mesh);
            this.curvePointA.dispose();
            this.curvePointA = null;
        }
        this.updateCurveLines();
    }

    public setCurvePointB(point: THREE.Vector3 | null): void {
        if (point) {
            if (!this.curvePointB) {
                this.curvePointB = new WorldNode(point, Config.editor.curveNodeColor);
                this.curvePointB.parent = this;
                this.mesh.add(this.curvePointB.mesh);
            } else {
                this.curvePointB.parent = this;
                this.curvePointB.update(point);
            }
        } else if (this.curvePointB) {
            this.mesh.remove(this.curvePointB.mesh);
            this.curvePointB.dispose();
            this.curvePointB = null;
        }
        this.updateCurveLines();
    }

    public override update(): void {
        this.updateCurveLines();
        super.update();
        this.applyWaterMaterial();
    }

    private applyWaterMaterial(): void {
        const mats = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
        for (const mat of mats) {
            const material = mat as THREE.MeshStandardMaterial;
            material.color.setHex(WATER_COLOR);
            material.userData.baseColor = material.color.clone();
            material.transparent = true;
            material.opacity = 0.8;
            material.depthWrite = false;
            material.side = THREE.DoubleSide;
            material.roughness = 0.15;
            material.metalness = 0.05;
            material.needsUpdate = true;
        }
    }

    private getBezierCurvePoints(): THREE.Vector3[] {
        return sampleCubicBezier(
            this.nodeA.mesh.position,
            this.curvePointA ? this.curvePointA.mesh.position : this.nodeA.mesh.position,
            this.curvePointB ? this.curvePointB.mesh.position : this.nodeB.mesh.position,
            this.nodeB.mesh.position,
            this._divisions,
        );
    }

    // Two components: a slow "wander" that meanders the bank gently even at low
    // Irregularity, and a "corner" component folded through sign(x)*|x|^0.4 so its
    // waveform snaps toward flat plateaus and back instead of rounding off - that fold is
    // what makes the bank read as jagged, cornered noise rather than a smooth wave once
    // Irregularity pushes it up. Both are pure functions of world position, so the
    // pattern never flickers when the mesh rebuilds.
    private getBankNoise(position: THREE.Vector3, channel: number): number {
        const wander = Math.sin(position.x * 0.37 + position.z * 0.48 + channel * 2.17);
        const cornerRaw = Math.sin(position.x * 1.9 - position.z * 2.6 + channel * 5.3)
            + 0.5 * Math.sin(position.x * 4.1 + position.z * 3.4 + channel * 8.7);
        const cornerFold = Math.sign(cornerRaw) * Math.pow(Math.min(1.5, Math.abs(cornerRaw)) / 1.5, 0.4);
        return THREE.MathUtils.clamp(wander * 0.5 + cornerFold * 0.5, -1, 1);
    }

    // The water's own half-width on each side, perturbed by bank noise. This is what
    // actually bends the water edge into corners; everything downstream (bed cross
    // offsets, the water quad strip, the bank profile beyond it) is built from these two
    // numbers so the water edge and the surrounding terrain always meet exactly, with no
    // gap or overlap, however irregular they get.
    private getChannelHalfWidths(position: THREE.Vector3): { left: number; right: number } {
        const nominal = Math.max(0.05, this.width / 2);
        const irregularityLevel = THREE.MathUtils.clamp(this.irregularityLevel, 0, MAX_IRREGULARITY);
        if (irregularityLevel <= 0) return { left: nominal, right: nominal };
        const perturb = (channel: number): number => {
            const noise = this.getBankNoise(position, channel);
            const fraction = THREE.MathUtils.clamp(irregularityLevel * 0.3 * noise, -0.85, 1.5);
            return Math.max(nominal * 0.15, nominal * (1 + fraction));
        };
        return { left: perturb(-1), right: perturb(1) };
    }

    // The centerline, sampled finely enough (via Detail Level and Divisions) for the
    // bank noise above to actually show up as corners rather than being smoothed away
    // between too-sparse points. Shared by the water mesh and the terrain sampling below
    // so both trace the same jagged line.
    // `overrides` only ever coarsens the *rendered water mesh* for an editor LOD
    // preview or a Unity export level - terrain-shaping (getSampledTerrainPoints) and
    // the terrain-cutting footprint (getOccupiedArea) always call this with no override,
    // so lowering a river's visual LOD never changes how it carves the terrain.
    private getCenterlineSamples(
        overrides?: { detailLevel?: number; divisions?: number },
    ): { point: THREE.Vector3; right: THREE.Vector3 }[] {
        const p0 = this.nodeA.mesh.position;
        const p1 = this.curvePointA?.mesh.position ?? p0;
        const p2 = this.curvePointB?.mesh.position ?? this.nodeB.mesh.position;
        const p3 = this.nodeB.mesh.position;
        const controlLength = p0.distanceTo(p1) + p1.distanceTo(p2) + p2.distanceTo(p3);
        const detailLevel = THREE.MathUtils.clamp(overrides?.detailLevel ?? this.detailLevel, 0.1, 4);
        const targetSpacing = 1.5 / detailLevel;
        // Detail provides automatic coverage for long channels, while Divisions
        // always adds explicit curve segments. Using max() here made Divisions
        // appear ignored whenever automatic sampling was already denser.
        const automaticDivisions = Math.min(64, Math.max(0, Math.ceil(controlLength / targetSpacing) - 1));
        const longitudinalDivisions = automaticDivisions + (overrides?.divisions ?? this._divisions);
        const points = sampleCubicBezier(p0, p1, p2, p3, longitudinalDivisions);
        return points.map((point, index) => {
            const previous = points[Math.max(0, index - 1)];
            const next = points[Math.min(points.length - 1, index + 1)];
            const forward = new THREE.Vector3().subVectors(next, previous).normalize();
            const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
            if (right.lengthSq() < 1e-8) right.copy(this.getRightAtIndex(points, index));
            return { point, right };
        });
    }

    // Keep a real, lowered riverbed below the water instead of opening a boolean hole.
    // Bank Slope is the actual angle between the bank and horizontal terrain:
    // horizontal run = vertical depth / tan(angle).
    // A non-zero lodIndex thins both the longitudinal row count and the cross-section/
    // profile density together (all three derive from the same `detailLevel` below), so
    // a coarser terrain LOD gets a proportionally coarser set of shaping constraints
    // instead of forcing a full-resolution river through a much smaller triangle budget.
    public getSampledTerrainPoints(terrainSurfaceY = this.nodeA.mesh.position.y, lodIndex = 0): TerrainCutPointInput[] {
        const overrides = this.getLODOverrides(lodIndex);
        const samplePoints = this.getCenterlineSamples(overrides);
        const detailLevel = THREE.MathUtils.clamp(overrides?.detailLevel ?? this.detailLevel, 0.1, 4);
        const targetSpacing = 1.5 / detailLevel;
        const minimumCrossSteps = detailLevel < 0.5 ? 1 : 2;
        const crossSteps = Math.min(12, Math.max(minimumCrossSteps, Math.ceil(this.width / targetSpacing)));
        const bedDepth = THREE.MathUtils.clamp(this.width * 0.25, 0.35, 4);
        const bankSlopeDegrees = THREE.MathUtils.clamp(this.bankSlope, 1, 89);
        const bankSmoothing = THREE.MathUtils.clamp(this.bankSmoothing, 0, 1);
        const irregularityLevel = THREE.MathUtils.clamp(this.irregularityLevel, 0, MAX_IRREGULARITY);
        const samples: TerrainCutPointInput[] = [];

        for (const { point, right } of samplePoints) {
            const { left: leftHalfWidth, right: rightHalfWidth } = this.getChannelHalfWidths(point);
            const bedY = point.y - bedDepth;
            const verticalDepth = Math.max(0.01, terrainSurfaceY - bedY);
            const straightBankRun = verticalDepth / Math.tan(THREE.MathUtils.degToRad(bankSlopeDegrees));
            // Smoothstep's maximum derivative is 1.5. Expanding the run by the
            // same amount ensures smoothing never makes the bank steeper.
            const bankRun = straightBankRun * (1 + 0.5 * bankSmoothing);
            const leftNoise = this.getBankNoise(point, -1);
            const rightNoise = this.getBankNoise(point, 1);
            // Irregularity only widens the nominal profile, so it cannot make a
            // bank steeper than Bank Slope requests.
            const irregularRun = (noise: number): number => (
                bankRun * (1 + irregularityLevel * 0.35 * (noise + 1) * 0.5)
            );
            const leftBankRun = irregularRun(leftNoise);
            const rightBankRun = irregularRun(rightNoise);

            for (let cross = 0; cross <= crossSteps; cross++) {
                const crossT = cross / crossSteps;
                const offset = THREE.MathUtils.lerp(-leftHalfWidth, rightHalfWidth, crossT);
                samples.push({
                    position: point.clone().addScaledVector(right, offset).setY(bedY),
                    radius: THREE.MathUtils.lerp(leftBankRun, rightBankRun, crossT),
                    maxSlopeDegrees: bankSlopeDegrees,
                    slopeSmoothing: bankSmoothing,
                });
            }

            // Explicit bank rows prevent a narrow river from being represented by
            // one huge triangle when terrain Mesh Detail is coarser than the bank.
            const profileSteps = Math.min(6, Math.max(1, Math.round(detailLevel * 2 + 1)));
            for (const side of [-1, 1]) {
                const sideNoise = side < 0 ? leftNoise : rightNoise;
                const sideBankRun = side < 0 ? leftBankRun : rightBankRun;
                const sideHalfWidth = side < 0 ? leftHalfWidth : rightHalfWidth;
                for (let step = 1; step <= profileSteps; step++) {
                    const t = step / profileSteps;
                    const smoothT = t * t * (3 - 2 * t);
                    const profileT = THREE.MathUtils.lerp(t, smoothT, bankSmoothing);
                    const verticalVariation = verticalDepth * Math.min(irregularityLevel, 1.5) * 0.08
                        * sideNoise * Math.sin(Math.PI * t);
                    const profileY = THREE.MathUtils.clamp(
                        THREE.MathUtils.lerp(bedY, terrainSurfaceY, profileT) + verticalVariation,
                        bedY,
                        terrainSurfaceY,
                    );
                    samples.push({
                        position: point.clone()
                            .addScaledVector(right, side * (sideHalfWidth + sideBankRun * t))
                            .setY(profileY),
                        radius: 0,
                        profileOnly: true,
                    });
                }
            }
        }
        return samples;
    }

    private getRightAtIndex(points: THREE.Vector3[], index: number): THREE.Vector3 {
        const up = new THREE.Vector3(0, 1, 0);
        if (index === 0) return this.getResolvedNodeBasis(0).right;
        if (index === points.length - 1) return this.getResolvedNodeBasis(1).right;
        const direction = new THREE.Vector3().subVectors(points[index + 1], points[index - 1]).normalize();
        return new THREE.Vector3().crossVectors(direction, up).normalize();
    }

    // Follows the same centerline and per-side half-widths as the terrain sampling
    // above, so getOccupiedArea() below cuts the terrain exactly where the water surface
    // sits - no gap, no overlap - and the water's own edge shows the same bank noise as
    // the ground around it instead of staying a plain straight-sided strip.
    private buildSurfaceTriangles(overrides?: { detailLevel?: number; divisions?: number }): Triangle[] {
        const samples = this.getCenterlineSamples(overrides);
        if (samples.length < 2) return [];

        const triangles: Triangle[] = [];
        for (let i = 0; i < samples.length - 1; i++) {
            const a = samples[i];
            const b = samples[i + 1];
            const widthsA = this.getChannelHalfWidths(a.point);
            const widthsB = this.getChannelHalfWidths(b.point);
            const aLeft = a.point.clone().addScaledVector(a.right, -widthsA.left);
            const aRight = a.point.clone().addScaledVector(a.right, widthsA.right);
            const bLeft = b.point.clone().addScaledVector(b.right, -widthsB.left);
            const bRight = b.point.clone().addScaledVector(b.right, widthsB.right);
            aLeft.y += WATER_SURFACE_OFFSET;
            aRight.y += WATER_SURFACE_OFFSET;
            bLeft.y += WATER_SURFACE_OFFSET;
            bRight.y += WATER_SURFACE_OFFSET;
            const uA = i / (samples.length - 1);
            const uB = (i + 1) / (samples.length - 1);
            triangles.push(new Triangle(
                aLeft, aRight, bRight,
                new THREE.Vector2(0, uA), new THREE.Vector2(1, uA), new THREE.Vector2(1, uB),
            ));
            triangles.push(new Triangle(
                aLeft, bRight, bLeft,
                new THREE.Vector2(0, uA), new THREE.Vector2(1, uB), new THREE.Vector2(0, uB),
            ));
        }
        return triangles;
    }

    protected override getGeometry(): GeometryGroup[] {
        const lodIndex = container.resolve(LODPreviewManager).level;
        return [{ name: 'water', triangles: this.buildSurfaceTriangles(this.getLODOverrides(lodIndex)) }];
    }

    // Water mesh at a specific Unity-export LOD level, without touching the live
    // element or its terrain-shaping/footprint (those always use full fidelity).
    public getExportGeometry(lodIndex: number): GeometryGroup[] {
        return [{ name: 'water', triangles: this.buildSurfaceTriangles(this.getLODOverrides(lodIndex)) }];
    }

    private getLODOverrides(lodIndex: number): { detailLevel?: number; divisions?: number } | undefined {
        if (lodIndex <= 0) return undefined;
        return {
            detailLevel: getDetailLevelForLOD(this.detailLevel, lodIndex),
            divisions: getDivisionsForLOD(this._divisions, lodIndex),
        };
    }

    public override getOccupiedArea(): OccupiedTriangle[] {
        const projected: OccupiedTriangle[] = [];
        const bankSlopeDegrees = THREE.MathUtils.clamp(this.bankSlope, 1, 89);
        for (const tri of this.buildSurfaceTriangles()) {
            const area = Math.abs(
                (tri.b.x - tri.a.x) * (tri.c.z - tri.a.z)
                - (tri.b.z - tri.a.z) * (tri.c.x - tri.a.x),
            ) * 0.5;
            if (area < 1e-8) continue;
            projected.push({ a: tri.a.clone(), b: tri.b.clone(), c: tri.c.clone(), bankSlopeDegrees });
        }
        return projected;
    }

    private updateCurveLines(): void {
        this.disposeCurveLines();

        if (!this.curvePointA || !this.curvePointB) return;

        const handleMaterial = new THREE.LineBasicMaterial({ color: Config.editor.curveNodeColor });
        this.handleLineA = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
            this.nodeA.mesh.position.clone(),
            this.curvePointA.mesh.position.clone(),
        ]), handleMaterial);
        this.mesh.add(this.handleLineA);

        this.handleLineB = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
            this.nodeB.mesh.position.clone(),
            this.curvePointB.mesh.position.clone(),
        ]), handleMaterial);
        this.mesh.add(this.handleLineB);
    }

    private disposeCurveLines(): void {
        const lines = [this.handleLineA, this.handleLineB].filter((line): line is THREE.Line => line !== null);
        const materials = new Set<THREE.Material>();
        for (const line of lines) {
            this.mesh.remove(line);
            line.geometry.dispose();
            const lineMaterials = Array.isArray(line.material) ? line.material : [line.material];
            for (const material of lineMaterials) materials.add(material);
        }
        for (const material of materials) material.dispose();
        this.handleLineA = null;
        this.handleLineB = null;
    }

    public override dispose(): void {
        this.disposeCurveLines();
        super.dispose();
    }

    public override getWidth(): number { return this.width; }

    public getNodeBasis(index: number): NodeBasis {
        const points = this.getBezierCurvePoints();
        const up = new THREE.Vector3(0, 1, 0);
        let forward: THREE.Vector3;
        if (index === 0) {
            forward = new THREE.Vector3().subVectors(points[1], points[0]).normalize();
        } else {
            const last = points.length - 1;
            forward = new THREE.Vector3().subVectors(points[last], points[last - 1]).normalize();
        }
        const right = new THREE.Vector3().crossVectors(forward, up).normalize();
        return { forward, right, up };
    }

    public override getProperties(): PropertyDefinition {
        const self = this;
        return {
            title: 'River Spline',
            icon: '&#8776;',
            sections: [{
                label: 'River',
                properties: [
                    {
                        type: 'number',
                        label: 'Width',
                        get: () => self.width,
                        set: (v: number) => { self.width = Math.max(0.1, v); self.update(); },
                        min: 0.1,
                        max: 100,
                        step: 0.1,
                    },
                    {
                        type: 'number',
                        label: 'Divisions',
                        get: () => self.divisions,
                        set: (v: number) => { self.divisions = Math.max(0, Math.round(v)); },
                        min: 0,
                        max: 32,
                        step: 1,
                    },
                    {
                        type: 'number',
                        label: 'Bank Slope',
                        get: () => self.bankSlope,
                        set: (v: number) => { self.bankSlope = THREE.MathUtils.clamp(v, 1, 89); self.update(); },
                        min: 1,
                        max: 89,
                        step: 1,
                    },
                    {
                        type: 'number',
                        label: 'Slope Smoothing',
                        get: () => self.bankSmoothing,
                        set: (v: number) => { self.bankSmoothing = THREE.MathUtils.clamp(v, 0, 1); self.update(); },
                        min: 0,
                        max: 1,
                        step: 0.05,
                    },
                    {
                        type: 'number',
                        label: 'Irregularity Level',
                        get: () => self.irregularityLevel,
                        set: (v: number) => { self.irregularityLevel = THREE.MathUtils.clamp(v, 0, MAX_IRREGULARITY); self.update(); },
                        min: 0,
                        max: MAX_IRREGULARITY,
                        step: 0.05,
                    },
                    {
                        type: 'number',
                        label: 'Detail Level',
                        get: () => self.detailLevel,
                        set: (v: number) => { self.detailLevel = THREE.MathUtils.clamp(v, 0.1, 4); self.update(); },
                        min: 0.1,
                        max: 4,
                        step: 0.1,
                    },
                ],
            }],
        };
    }

    public serialize(id: number): ElementData {
        const curveA = this.curvePointA?.mesh.position;
        const curveB = this.curvePointB?.mesh.position;
        return {
            type: 'river',
            id,
            nodes: [
                { x: this.nodeA.mesh.position.x, y: this.nodeA.mesh.position.y, z: this.nodeA.mesh.position.z },
                { x: this.nodeB.mesh.position.x, y: this.nodeB.mesh.position.y, z: this.nodeB.mesh.position.z },
            ],
            textures: {},
            textureRotations: {},
            width: this.width,
            divisions: this.divisions,
            curvePointA: curveA ? { x: curveA.x, y: curveA.y, z: curveA.z } : null,
            curvePointB: curveB ? { x: curveB.x, y: curveB.y, z: curveB.z } : null,
            riverBankSlope: this.bankSlope,
            riverBankSmoothing: this.bankSmoothing,
            riverIrregularityLevel: this.irregularityLevel,
            riverDetailLevel: this.detailLevel,
        };
    }

    public static deserialize(data: ElementData): RiverSpline {
        const a = data.nodes[0] ?? { x: 0, y: 0, z: 0 };
        const b = data.nodes[1] ?? { x: 1, y: 0, z: 0 };
        const river = new RiverSpline(
            new THREE.Vector3(a.x, a.y, a.z),
            new THREE.Vector3(b.x, b.y, b.z),
        );
        river.width = Math.max(0.1, data.width ?? 4);
        river.bankSlope = THREE.MathUtils.clamp(data.riverBankSlope ?? 70, 1, 89);
        river.bankSmoothing = THREE.MathUtils.clamp(data.riverBankSmoothing ?? 0.65, 0, 1);
        river.irregularityLevel = THREE.MathUtils.clamp(data.riverIrregularityLevel ?? 0, 0, MAX_IRREGULARITY);
        river.detailLevel = THREE.MathUtils.clamp(data.riverDetailLevel ?? 1, 0.1, 4);
        if (data.divisions && data.divisions > 0) {
            river.divisions = data.divisions;
            if (data.curvePointA) river.setCurvePointA(new THREE.Vector3(data.curvePointA.x, data.curvePointA.y, data.curvePointA.z));
            if (data.curvePointB) river.setCurvePointB(new THREE.Vector3(data.curvePointB.x, data.curvePointB.y, data.curvePointB.z));
        }
        return river;
    }
}
