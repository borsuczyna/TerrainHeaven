import * as THREE from 'three';
import { container } from 'tsyringe';
import WorldElement, { type NodeBasis, type GeometryGroup, type ElementData, type OccupiedTriangle, type UVTransform } from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Terrain from './Terrain.ts';
import Config from '../utils/Config';
import { sampleCubicBezier } from '../utils/Bezier';
import type { PropertyDefinition, SectionItem } from '../editor/Properties';
import GeometrySweepManager, { type GeometryLineSegment, type GeometryLineSection } from '../editor/GeometrySweepManager';
import SceneManager from '../editor/SceneManager';

export type EdgeType = 'none' | 'sidewalk';
export type PillarShape = 'box' | 'circular';

type RoadGeometryGroup = 'road' | 'sidewalk' | 'bridgeDeck' | 'bridgePillars';

interface GeometryLineContext {
    halfWidth: number;
    sidewalkWidth: number;
    curbHeight: number;
    deckThickness: number;
    leftDistance: number;
    rightDistance: number;
    maxEdgeLength: number;
    crownHeight: number;
}

export default class Road extends WorldElement {
    public get nodeA(): WorldNode { return this.nodes[0]; }
    public get nodeB(): WorldNode { return this.nodes[1]; }

    public width: number = 3;
    public lanes: number = 2;
    public edgeType: EdgeType = 'none';
    public sidewalkWidth: number = 1;
    public curbHeight: number = 0.15;
    public roadTexStretch: number = 1;
    public sidewalkTexStretch: number = 1;
    public roadCrown: number = 0;
    public bridgeEnabled: boolean = false;
    public bridgePillarShape: PillarShape = 'box';
    public bridgePillarSegments: number = 12;
    public bridgePillarDistance: number = 8;
    public bridgePillarCount: number = 2;
    public bridgePillarWidth: number = 0.8;
    public bridgePillarInset: number = 0.4;
    public bridgeDeckThickness: number = 0.5;

    public override getWidth(): number { return this.width; }
    public override getSidewalkWidth(): number { return this.edgeType === 'sidewalk' ? this.sidewalkWidth : 0; }
    public override getCurbHeight(): number { return this.edgeType === 'sidewalk' ? this.curbHeight : 0; }
    public override dependsOnTerrainSurface(): boolean { return this.bridgeEnabled; }
    private _divisions: number = 0;
    private curvePointA: WorldNode | null = null;
    private curvePointB: WorldNode | null = null;

    public getCurvePointAPosition(): THREE.Vector3 | null {
        return this.curvePointA ? this.curvePointA.mesh.position.clone() : null;
    }

    public getCurvePointBPosition(): THREE.Vector3 | null {
        return this.curvePointB ? this.curvePointB.mesh.position.clone() : null;
    }

    public override getAffectedElementsForNode(node: WorldNode): WorldElement[] {
        const affected = new Set(super.getAffectedElementsForNode(node));
        if (node !== this.curvePointA && node !== this.curvePointB) return [...affected];

        const queue: WorldElement[] = [this];
        while (queue.length > 0) {
            const element = queue.shift()!;
            if (affected.has(element) && element !== this) continue;
            affected.add(element);

            for (const connection of element.connections.values()) {
                if (!affected.has(connection.element)) queue.push(connection.element);
            }
        }
        return [...affected];
    }

    private curveLineA: THREE.Line | null = null;
    private curveLineB: THREE.Line | null = null;
    private laneLines: THREE.Line[] = [];
    private readonly geometrySweepManager: GeometrySweepManager = container.resolve(GeometrySweepManager);
    private readonly terrainRaycaster = new THREE.Raycaster();
    private readonly uvTransforms: Map<RoadGeometryGroup, UVTransform> = new Map([
        ['road', { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 }],
        ['sidewalk', { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 }],
        ['bridgeDeck', { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 }],
        ['bridgePillars', { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 }],
    ]);

    public get divisions(): number { return this._divisions; }
    public set divisions(value: number) {
        this._divisions = Math.max(0, Math.round(value));
        if (this._divisions > 0) {
            // Auto-create curve points at 1/3 and 2/3 along the line if missing
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
            // Remove curve points when divisions is 0
            this.setCurvePointA(null);
            this.setCurvePointB(null);
        }
        this.updateCurveLines();
    }

    constructor(positionA: THREE.Vector3, positionB: THREE.Vector3) {
        super();
        this.setNode(0, new WorldNode(positionA, Config.editor.nodeColor));
        this.setNode(1, new WorldNode(positionB, Config.editor.nodeColor));
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
    }

    private updateCurveLines(): void {
        this.disposeCurveLines();

        if (!this.curvePointA || !this.curvePointB) return;

        const handleMaterial = new THREE.LineBasicMaterial({ color: Config.editor.curveNodeColor });

        const geoA = new THREE.BufferGeometry().setFromPoints([
            this.nodeA.mesh.position.clone(),
            this.curvePointA.mesh.position.clone(),
        ]);
        this.curveLineA = new THREE.Line(geoA, handleMaterial);
        this.mesh.add(this.curveLineA);

        const geoB = new THREE.BufferGeometry().setFromPoints([
            this.nodeB.mesh.position.clone(),
            this.curvePointB.mesh.position.clone(),
        ]);
        this.curveLineB = new THREE.Line(geoB, handleMaterial);
        this.mesh.add(this.curveLineB);

        const points = this.getBezierCurvePoints();
        const up = new THREE.Vector3(0, 1, 0);
        const halfWidthStart = this.getResolvedHalfWidth(0);
        const halfWidthEnd = this.getResolvedHalfWidth(1);

        const getRightAtIndex = (index: number): THREE.Vector3 => {
            if (index === 0) return this.getResolvedNodeBasis(0).right;
            if (index === points.length - 1) return this.getResolvedNodeBasis(1).right;
            const next = points[index + 1];
            const prev = points[index - 1];
            const direction = new THREE.Vector3().subVectors(next, prev).normalize();
            return new THREE.Vector3().crossVectors(direction, up).normalize();
        };

        const laneCount = Math.max(1, Math.round(this.lanes));

        // Draw N+1 lane boundary lines (edges + interior dividers)
        for (let b = 0; b <= laneCount; b++) {
            const frac = b / laneCount; // 0..1
            const offsetPoints: THREE.Vector3[] = [];
            for (let i = 0; i < points.length; i++) {
                const t = i / (points.length - 1);
                const hw = halfWidthStart + (halfWidthEnd - halfWidthStart) * t;
                const offset = -hw + 2 * hw * frac;
                const right = getRightAtIndex(i);
                offsetPoints.push(points[i].clone().add(right.clone().multiplyScalar(offset)));
            }
            const isEdge = b === 0 || b === laneCount;
            const mat = new THREE.LineBasicMaterial({ color: isEdge ? 0xffffff : 0x888888 });
            const geo = new THREE.BufferGeometry().setFromPoints(offsetPoints);
            const line = new THREE.Line(geo, mat);
            this.laneLines.push(line);
            this.mesh.add(line);
        }
    }

    private disposeCurveLines(): void {
        const lines = [this.curveLineA, this.curveLineB, ...this.laneLines]
            .filter((line): line is THREE.Line => line !== null);
        const materials = new Set<THREE.Material>();

        for (const line of lines) {
            this.mesh.remove(line);
            line.geometry.dispose();
            const lineMaterials = Array.isArray(line.material) ? line.material : [line.material];
            for (const material of lineMaterials) materials.add(material);
        }
        for (const material of materials) material.dispose();

        this.curveLineA = null;
        this.curveLineB = null;
        this.laneLines = [];
    }

    public override dispose(): void {
        this.disposeCurveLines();
        super.dispose();
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

    private getEndCrown(nodeIndex: number): number {
        const conn = this.connections.get(nodeIndex);
        if (!conn) return this.roadCrown;
        if (!(conn.element instanceof Road)) return 0;
        // Average both crowns so each road produces the same junction height
        return (this.roadCrown + conn.element.roadCrown) / 2;
    }

    private getResolvedBridgeDeckThickness(nodeIndex: number): number {
        const conn = this.connections.get(nodeIndex);
        if (!conn) return this.bridgeDeckThickness;
        if (!(conn.element instanceof Road) || !conn.element.bridgeEnabled) return this.bridgeDeckThickness;
        return (this.bridgeDeckThickness + conn.element.bridgeDeckThickness) / 2;
    }

    private isRoadGeometryGroup(group: string): group is RoadGeometryGroup {
        return group === 'road' || group === 'sidewalk' || group === 'bridgeDeck' || group === 'bridgePillars';
    }

    private getStoredUVTransform(group: RoadGeometryGroup): UVTransform {
        const stored = this.uvTransforms.get(group);
        if (stored) return stored;
        const fallback: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
        this.uvTransforms.set(group, fallback);
        return fallback;
    }

    private serializeUVTransforms(): Record<string, UVTransform> {
        const out: Record<string, UVTransform> = {};
        const groups: RoadGeometryGroup[] = ['road', 'sidewalk', 'bridgeDeck', 'bridgePillars'];
        for (const group of groups) {
            const t = this.getStoredUVTransform(group);
            out[group] = { offsetX: t.offsetX, offsetY: t.offsetY, scaleX: t.scaleX, scaleY: t.scaleY };
        }
        return out;
    }

    private loadUVTransforms(uvTransforms: Record<string, UVTransform>): void {
        for (const [groupName, transform] of Object.entries(uvTransforms)) {
            if (!this.isRoadGeometryGroup(groupName)) continue;
            this.uvTransforms.set(groupName, {
                offsetX: Number.isFinite(transform.offsetX) ? transform.offsetX : 0,
                offsetY: Number.isFinite(transform.offsetY) ? transform.offsetY : 0,
                scaleX: Number.isFinite(transform.scaleX) ? Math.max(0.1, transform.scaleX) : 1,
                scaleY: Number.isFinite(transform.scaleY) ? Math.max(0.1, transform.scaleY) : 1,
            });
        }
    }

    private applyUVTransformToTriangles(group: RoadGeometryGroup, triangles: Triangle[]): void {
        const t = this.getStoredUVTransform(group);
        if (Math.abs(t.offsetX) < 1e-8 && Math.abs(t.offsetY) < 1e-8
            && Math.abs(t.scaleX - 1) < 1e-8 && Math.abs(t.scaleY - 1) < 1e-8) {
            return;
        }

        for (const tri of triangles) {
            tri.uvA.set(tri.uvA.x * t.scaleX + t.offsetX, tri.uvA.y * t.scaleY + t.offsetY);
            tri.uvB.set(tri.uvB.x * t.scaleX + t.offsetX, tri.uvB.y * t.scaleY + t.offsetY);
            tri.uvC.set(tri.uvC.x * t.scaleX + t.offsetX, tri.uvC.y * t.scaleY + t.offsetY);
        }
    }

    public override getUVGroups(): string[] {
        const groups: string[] = ['road'];
        if (this.edgeType === 'sidewalk') groups.push('sidewalk');
        if (this.bridgeEnabled) {
            groups.push('bridgeDeck', 'bridgePillars');
        }
        return groups;
    }

    public override getUVTransform(group: string): UVTransform {
        if (!this.isRoadGeometryGroup(group)) return super.getUVTransform(group);
        const t = this.getStoredUVTransform(group);
        return { offsetX: t.offsetX, offsetY: t.offsetY, scaleX: t.scaleX, scaleY: t.scaleY };
    }

    public override setUVTransform(group: string, transform: UVTransform): void {
        if (!this.isRoadGeometryGroup(group)) {
            super.setUVTransform(group, transform);
            return;
        }

        this.uvTransforms.set(group, {
            offsetX: Number.isFinite(transform.offsetX) ? transform.offsetX : 0,
            offsetY: Number.isFinite(transform.offsetY) ? transform.offsetY : 0,
            scaleX: Number.isFinite(transform.scaleX) ? Math.max(0.1, transform.scaleX) : 1,
            scaleY: Number.isFinite(transform.scaleY) ? Math.max(0.1, transform.scaleY) : 1,
        });
        this.update();
    }

    public connectWith(thisNodeIndex: number, otherRoad: Road, otherNodeIndex: number = 0): void {
        this.connect(thisNodeIndex, otherRoad, otherNodeIndex);
        this.updateCurveLines();
        this.update();
        otherRoad.update();
    }

    public override getOccupiedArea(): OccupiedTriangle[] {
        if (this.bridgeEnabled) {
            return [];
        }

        const projected: OccupiedTriangle[] = [];
        const groups = this.getGeometry();

        for (const group of groups) {
            for (const tri of group.triangles) {
                const area = Math.abs(
                    (tri.b.x - tri.a.x) * (tri.c.z - tri.a.z)
                    - (tri.b.z - tri.a.z) * (tri.c.x - tri.a.x),
                ) * 0.5;
                if (area < 1e-8) continue;

                // Preserve the real surface heights. In particular, sidewalk
                // tops stay at curb height while an open road end remains at
                // the road profile instead of lifting the whole cut outline.
                projected.push({
                    a: tri.a.clone(),
                    b: tri.b.clone(),
                    c: tri.c.clone(),
                });
            }
        }

        return projected;
    }

    public override serialize(id: number): ElementData {
        const { textures, textureRotations } = this.collectTextureMaps();
        const nodes = [
            { x: this.getNode(0).mesh.position.x, y: this.getNode(0).mesh.position.y, z: this.getNode(0).mesh.position.z },
            { x: this.getNode(1).mesh.position.x, y: this.getNode(1).mesh.position.y, z: this.getNode(1).mesh.position.z },
        ];
        let curvePointA: { x: number; y: number; z: number } | null = null;
        let curvePointB: { x: number; y: number; z: number } | null = null;
        if (this.divisions > 0) {
            const cpA = this.getCurvePointAPosition();
            const cpB = this.getCurvePointBPosition();
            if (cpA) curvePointA = { x: cpA.x, y: cpA.y, z: cpA.z };
            if (cpB) curvePointB = { x: cpB.x, y: cpB.y, z: cpB.z };
        }
        return {
            type: 'road', id, nodes, textures, textureRotations,
            uvTransforms: this.serializeUVTransforms(),
            width: this.width,
            lanes: this.lanes,
            divisions: this.divisions,
            edgeType: this.edgeType,
            sidewalkWidth: this.sidewalkWidth,
            curbHeight: this.curbHeight,
            roadCrown: this.roadCrown,
            curvePointA,
            curvePointB,
            bridgeEnabled: this.bridgeEnabled,
            bridgePillarShape: this.bridgePillarShape,
            bridgePillarSegments: this.bridgePillarSegments,
            bridgePillarDistance: this.bridgePillarDistance,
            bridgePillarCount: this.bridgePillarCount,
            bridgePillarWidth: this.bridgePillarWidth,
            bridgePillarInset: this.bridgePillarInset,
            bridgeDeckThickness: this.bridgeDeckThickness,
        };
    }

    public static deserialize(ed: ElementData): Road {
        const posA = new THREE.Vector3(ed.nodes[0].x, ed.nodes[0].y, ed.nodes[0].z);
        const posB = new THREE.Vector3(ed.nodes[1].x, ed.nodes[1].y, ed.nodes[1].z);
        const road = new Road(posA, posB);
        road.width = ed.width ?? 3;
        road.lanes = ed.lanes ?? 2;
        road.edgeType = (ed.edgeType as 'none' | 'sidewalk') ?? 'none';
        road.sidewalkWidth = ed.sidewalkWidth ?? 1;
        road.curbHeight = ed.curbHeight ?? 0.15;
        road.roadCrown = ed.roadCrown ?? 0;
        road.bridgeEnabled = ed.bridgeEnabled ?? false;
        road.bridgePillarShape = (ed.bridgePillarShape as PillarShape) ?? 'box';
        road.bridgePillarSegments = Math.max(3, Math.round(ed.bridgePillarSegments ?? 12));
        road.bridgePillarDistance = Math.max(0.1, ed.bridgePillarDistance ?? 8);
        road.bridgePillarCount = Math.max(1, Math.round(ed.bridgePillarCount ?? 2));
        road.bridgePillarWidth = Math.max(0.1, ed.bridgePillarWidth ?? 0.8);
        road.bridgePillarInset = Math.max(0, ed.bridgePillarInset ?? 0.4);
        road.bridgeDeckThickness = Math.max(0.05, ed.bridgeDeckThickness ?? 0.5);
        if (ed.uvTransforms) {
            road.loadUVTransforms(ed.uvTransforms);
        }
        if (ed.divisions && ed.divisions > 0) {
            road.divisions = ed.divisions;
            if (ed.curvePointA) road.setCurvePointA(new THREE.Vector3(ed.curvePointA.x, ed.curvePointA.y, ed.curvePointA.z));
            if (ed.curvePointB) road.setCurvePointB(new THREE.Vector3(ed.curvePointB.x, ed.curvePointB.y, ed.curvePointB.z));
        }
        return road;
    }

    public getProperties(): PropertyDefinition {
        const self = this;
        const makeNodeVec3 = (label: string, node: WorldNode) => ({
            type: 'vector3' as const,
            label,
            get: () => node.mesh.position.clone(),
            set: (v: THREE.Vector3) => { node.update(v); },
        });

        const makeNodeSection = (label: string, node: WorldNode, nodeIndex: number) => {
            const props: SectionItem[] = [makeNodeVec3('Position', node)];
            if (this.isConnected(nodeIndex)) {
                props.push({
                    type: 'button' as const,
                    label: 'Disconnect',
                    onClick: () => { self.disconnect(nodeIndex); self.onPropertiesChanged?.(); },
                });
            }
            return { label, properties: props };
        };

        const sections = [
            makeNodeSection('Node A', this.nodeA, 0),
            makeNodeSection('Node B', this.nodeB, 1),
            {
                label: 'Road',
                properties: [
                    {
                        type: 'number' as const,
                        label: 'Width',
                        get: () => self.width,
                        set: (v: number) => { self.width = v; self.update(); },
                        min: 0.1,
                        step: 0.1,
                    },
                    {
                        type: 'number' as const,
                        label: 'Lanes',
                        get: () => self.lanes,
                        set: (v: number) => { self.lanes = Math.max(1, Math.round(v)); self.update(); },
                        min: 1,
                        step: 1,
                    },
                    {
                        type: 'number' as const,
                        label: 'Divisions',
                        get: () => self.divisions,
                        set: (v: number) => { self.divisions = Math.max(0, Math.round(v)); self.update(); },
                        min: 0,
                        step: 1,
                    },
                    {
                        type: 'number' as const,
                        label: 'Crown',
                        get: () => self.roadCrown,
                        set: (v: number) => { self.roadCrown = v; self.update(); },
                        min: 0,
                        step: 0.01,
                    },
                ],
            },
            {
                label: 'Edges',
                properties: [
                    {
                        type: 'select' as const,
                        label: 'Type',
                        options: [
                            { label: 'None', value: 'none' },
                            { label: 'Sidewalk', value: 'sidewalk' },
                        ],
                        get: () => self.edgeType,
                        set: (v: string) => { self.edgeType = v as EdgeType; self.update(); self.onPropertiesChanged?.(); },
                    },
                    ...(self.edgeType === 'sidewalk' ? [
                        {
                            type: 'number' as const,
                            label: 'Sidewalk Width',
                            get: () => self.sidewalkWidth,
                            set: (v: number) => { self.sidewalkWidth = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Curb Height',
                            get: () => self.curbHeight,
                            set: (v: number) => { self.curbHeight = Math.max(0, v); self.update(); },
                            min: 0,
                            step: 0.05,
                        },
                    ] : []),
                ],
            },
            {
                label: 'Bridge',
                properties: [
                    {
                        type: 'boolean' as const,
                        label: 'Enabled',
                        get: () => self.bridgeEnabled,
                        set: (v: boolean) => {
                            self.bridgeEnabled = v;
                            self.update();
                            self.onPropertiesChanged?.();
                        },
                    },
                    ...(self.bridgeEnabled ? [
                        {
                            type: 'number' as const,
                            label: 'Deck Thickness',
                            get: () => self.bridgeDeckThickness,
                            set: (v: number) => { self.bridgeDeckThickness = Math.max(0.05, v); self.update(); },
                            min: 0.05,
                            step: 0.05,
                        },
                        {
                            type: 'select' as const,
                            label: 'Pillar Shape',
                            options: [
                                { label: 'Box', value: 'box' },
                                { label: 'Circular', value: 'circular' },
                            ],
                            get: () => self.bridgePillarShape,
                            set: (v: string) => {
                                self.bridgePillarShape = (v as PillarShape) === 'circular' ? 'circular' : 'box';
                                self.update();
                                self.onPropertiesChanged?.();
                            },
                        },
                        {
                            type: 'number' as const,
                            label: 'Pillar Distance',
                            get: () => self.bridgePillarDistance,
                            set: (v: number) => { self.bridgePillarDistance = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Pillar Count',
                            get: () => self.bridgePillarCount,
                            set: (v: number) => { self.bridgePillarCount = Math.max(1, Math.round(v)); self.update(); },
                            min: 1,
                            step: 1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Pillar Width',
                            get: () => self.bridgePillarWidth,
                            set: (v: number) => { self.bridgePillarWidth = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Pillar Inset',
                            get: () => self.bridgePillarInset,
                            set: (v: number) => { self.bridgePillarInset = Math.max(0, v); self.update(); },
                            min: 0,
                            step: 0.1,
                        },
                        ...(self.bridgePillarShape === 'circular' ? [{
                            type: 'number' as const,
                            label: 'Pillar Segments',
                            get: () => self.bridgePillarSegments,
                            set: (v: number) => { self.bridgePillarSegments = Math.max(3, Math.round(v)); self.update(); },
                            min: 3,
                            step: 1,
                        }] : []),
                    ] : []),
                ],
            },
            {
                label: 'Textures',
                properties: [
                    {
                        type: 'select' as const,
                        label: 'Road Rot.',
                        options: [
                            { label: '0°', value: '0' },
                            { label: '90°', value: '90' },
                            { label: '180°', value: '180' },
                            { label: '270°', value: '270' },
                        ],
                        get: () => String(self.textureRotations.get('road') ?? 0),
                        set: (v: string) => { self.setTextureRotation('road', Number(v)); },
                    },
                    {
                        type: 'number' as const,
                        label: 'Road Stretch',
                        get: () => self.roadTexStretch,
                        set: (v: number) => { self.roadTexStretch = Math.max(0.1, v); self.update(); },
                        min: 0.1,
                        step: 0.1,
                    },
                    {
                        type: 'select' as const,
                        label: 'Sidewalk Rot.',
                        options: [
                            { label: '0°', value: '0' },
                            { label: '90°', value: '90' },
                            { label: '180°', value: '180' },
                            { label: '270°', value: '270' },
                        ],
                        get: () => String(self.textureRotations.get('sidewalk') ?? 0),
                        set: (v: string) => { self.setTextureRotation('sidewalk', Number(v)); },
                    },
                    {
                        type: 'number' as const,
                        label: 'Sidewalk Stretch',
                        get: () => self.sidewalkTexStretch,
                        set: (v: number) => { self.sidewalkTexStretch = Math.max(0.1, v); self.update(); },
                        min: 0.1,
                        step: 0.1,
                    },
                ],
            },
        ];

        if (this.curvePointA) {
            sections.push({
                label: 'Curve Point A',
                properties: [makeNodeVec3('Position', this.curvePointA)],
            });
        }
        if (this.curvePointB) {
            sections.push({
                label: 'Curve Point B',
                properties: [makeNodeVec3('Position', this.curvePointB)],
            });
        }

        return { title: 'Road', icon: '&#9776;', sections };
    }

    protected getGeometry(): GeometryGroup[] {
        const edge = this.computeEdgeData();
        const groups = this.sweepGeometryLine(edge);
        if (!this.bridgeEnabled) return groups;

        const pillarTriangles = this.getBridgePillarTriangles(edge);
        if (pillarTriangles.length > 0) {
            groups.push({ name: 'bridgePillars', triangles: pillarTriangles });
        }
        return groups;
    }

    private getCrownAt(t: number): number {
        const crownA = this.getEndCrown(0);
        const crownB = this.getEndCrown(1);
        return t < 0.5
            ? crownA + (this.roadCrown - crownA) * t * 2
            : this.roadCrown + (crownB - this.roadCrown) * (t - 0.5) * 2;
    }

    private getLaneHeightAtFrac(frac: number, crownHeight: number): number {
        return crownHeight * (1 - Math.abs(2 * frac - 1));
    }

    private getBridgeOuterHalfWidth(context: GeometryLineContext): number {
        return context.halfWidth + (this.edgeType === 'sidewalk' ? context.sidewalkWidth : 0);
    }

    private getDeckTopHeightAtLateral(lateral: number, context: GeometryLineContext): number {
        if (this.edgeType === 'sidewalk' && Math.abs(lateral) > context.halfWidth + 1e-6) {
            return context.curbHeight;
        }

        if (context.halfWidth <= 1e-6) {
            return this.getLaneHeightAtFrac(0.5, context.crownHeight);
        }

        const laneFrac = THREE.MathUtils.clamp((lateral + context.halfWidth) / (2 * context.halfWidth), 0, 1);
        return this.getLaneHeightAtFrac(laneFrac, context.crownHeight);
    }

    private getGeometryLine(context: GeometryLineContext): GeometryLineSegment<RoadGeometryGroup>[] {
        const segments: GeometryLineSegment<RoadGeometryGroup>[] = [];
        const laneCount = Math.max(1, Math.round(this.lanes));
        const laneVAtFrac = (frac: number, invert: boolean): number => {
            const v = context.leftDistance + (context.rightDistance - context.leftDistance) * frac;
            const maxV = context.maxEdgeLength * 2;
            return (invert ? maxV - v : v) * this.roadTexStretch;
        };

        for (let lane = 0; lane < laneCount; lane++) {
            const laneLeftFrac = lane / laneCount;
            const laneRightFrac = (lane + 1) / laneCount;
            const invert = lane % 2 === 1;
            segments.push({
                group: 'road',
                start: {
                    lateral: -context.halfWidth + 2 * context.halfWidth * laneLeftFrac,
                    height: this.getLaneHeightAtFrac(laneLeftFrac, context.crownHeight),
                    u: invert ? 1 : 0,
                    v: laneVAtFrac(laneLeftFrac, invert),
                },
                end: {
                    lateral: -context.halfWidth + 2 * context.halfWidth * laneRightFrac,
                    height: this.getLaneHeightAtFrac(laneRightFrac, context.crownHeight),
                    u: invert ? 0 : 1,
                    v: laneVAtFrac(laneRightFrac, invert),
                },
            });
        }

        if (this.edgeType === 'sidewalk') {
            const leftV = context.leftDistance * this.sidewalkTexStretch;
            const rightV = context.rightDistance * this.sidewalkTexStretch;

            // Right curb face: inner bottom -> inner top
            segments.push({
                group: 'sidewalk',
                start: {
                    lateral: context.halfWidth,
                    height: 0,
                    u: 0,
                    v: rightV,
                },
                end: {
                    lateral: context.halfWidth,
                    height: context.curbHeight,
                    u: 1,
                    v: rightV,
                },
            });

            // Right sidewalk top: inner -> outer
            segments.push({
                group: 'sidewalk',
                start: {
                    lateral: context.halfWidth,
                    height: context.curbHeight,
                    u: 0,
                    v: rightV,
                },
                end: {
                    lateral: context.halfWidth + context.sidewalkWidth,
                    height: context.curbHeight,
                    u: 1,
                    v: rightV,
                },
            });

            // Left curb face (reversed to keep outward normals): inner top -> inner bottom
            segments.push({
                group: 'sidewalk',
                start: {
                    lateral: -context.halfWidth,
                    height: context.curbHeight,
                    u: 1,
                    v: leftV,
                },
                end: {
                    lateral: -context.halfWidth,
                    height: 0,
                    u: 0,
                    v: leftV,
                },
            });

            // Left sidewalk top (reversed to keep upward normals): outer -> inner
            segments.push({
                group: 'sidewalk',
                start: {
                    lateral: -(context.halfWidth + context.sidewalkWidth),
                    height: context.curbHeight,
                    u: 1,
                    v: leftV,
                },
                end: {
                    lateral: -context.halfWidth,
                    height: context.curbHeight,
                    u: 0,
                    v: leftV,
                },
            });
        }

        if (this.bridgeEnabled) {
            const deckThickness = Math.max(0.05, context.deckThickness);
            const deckSegments: GeometryLineSegment<RoadGeometryGroup>[] = [];

            for (const segment of segments) {
                deckSegments.push({
                    group: 'bridgeDeck',
                    start: {
                        lateral: segment.end.lateral,
                        height: segment.end.height - deckThickness,
                        u: segment.end.u,
                        v: segment.end.v,
                    },
                    end: {
                        lateral: segment.start.lateral,
                        height: segment.start.height - deckThickness,
                        u: segment.start.u,
                        v: segment.start.v,
                    },
                });
            }

            const outerHalfWidth = this.getBridgeOuterHalfWidth(context);
            const rightTop = this.getDeckTopHeightAtLateral(outerHalfWidth, context);
            const leftTop = this.getDeckTopHeightAtLateral(-outerHalfWidth, context);
            const rightV = context.rightDistance * this.roadTexStretch;
            const leftV = context.leftDistance * this.roadTexStretch;

            // Outer side walls close top deck to underside.
            deckSegments.push({
                group: 'bridgeDeck',
                start: {
                    lateral: outerHalfWidth,
                    height: rightTop,
                    u: 1,
                    v: rightV,
                },
                end: {
                    lateral: outerHalfWidth,
                    height: rightTop - deckThickness,
                    u: 0,
                    v: rightV,
                },
            });
            deckSegments.push({
                group: 'bridgeDeck',
                start: {
                    lateral: -outerHalfWidth,
                    height: leftTop - deckThickness,
                    u: 0,
                    v: leftV,
                },
                end: {
                    lateral: -outerHalfWidth,
                    height: leftTop,
                    u: 1,
                    v: leftV,
                },
            });

            segments.push(...deckSegments);
        }

        return segments;
    }

    private sweepGeometryLine(edge: ReturnType<Road['computeEdgeData']>): GeometryGroup[] {
        const pointCount = edge.points.length;
        if (pointCount < 2) {
            return [{ name: 'road', triangles: [] }];
        }

        const swStart = this.getResolvedSidewalkWidth(0);
        const swEnd = this.getResolvedSidewalkWidth(1);
        const chStart = this.getResolvedCurbHeight(0);
        const chEnd = this.getResolvedCurbHeight(1);
        const dtStart = this.getResolvedBridgeDeckThickness(0);
        const dtEnd = this.getResolvedBridgeDeckThickness(1);

        const geometrySections: GeometryLineSection<RoadGeometryGroup>[] = [];
        for (let i = 0; i < pointCount; i++) {
            const t = i / (pointCount - 1);
            const context: GeometryLineContext = {
                halfWidth: edge.halfWidths[i],
                sidewalkWidth: swStart + (swEnd - swStart) * t,
                curbHeight: chStart + (chEnd - chStart) * t,
                deckThickness: dtStart + (dtEnd - dtStart) * t,
                leftDistance: edge.leftCumDist[i],
                rightDistance: edge.rightCumDist[i],
                maxEdgeLength: edge.maxEdgeLen,
                crownHeight: this.getCrownAt(t),
            };
            geometrySections.push({
                origin: edge.points[i],
                right: edge.rightVecs[i],
                segments: this.getGeometryLine(context),
            });
        }

        const sweptGroups = this.geometrySweepManager.sweepSections(geometrySections);
        const roadGroup = sweptGroups.find((group) => group.name === 'road');
        const sidewalkGroup = sweptGroups.find((group) => group.name === 'sidewalk');
        const bridgeDeckGroup = sweptGroups.find((group) => group.name === 'bridgeDeck');

        if (roadGroup) this.applyUVTransformToTriangles('road', roadGroup.triangles);
        if (sidewalkGroup) this.applyUVTransformToTriangles('sidewalk', sidewalkGroup.triangles);
        if (bridgeDeckGroup) this.applyUVTransformToTriangles('bridgeDeck', bridgeDeckGroup.triangles);

        const groups: GeometryGroup[] = [{ name: 'road', triangles: roadGroup?.triangles ?? [] }];
        if (sidewalkGroup && sidewalkGroup.triangles.length > 0) {
            groups.push(sidewalkGroup);
        }
        if (bridgeDeckGroup && bridgeDeckGroup.triangles.length > 0) {
            groups.push(bridgeDeckGroup);
        }
        return groups;
    }

    private getBridgePillarTriangles(edge: ReturnType<Road['computeEdgeData']>): Triangle[] {
        const triangles: Triangle[] = [];
        const terrainMeshes = this.getTerrainMeshes();

        const totalLength = edge.centerTotal;
        if (totalLength <= 1e-6) return triangles;

        const spacing = Math.max(0.1, this.bridgePillarDistance);
        const margin = Math.min(spacing * 0.5, totalLength * 0.5);
        const rowDistances: number[] = [];
        for (let d = margin; d <= totalLength - margin + 1e-6; d += spacing) {
            rowDistances.push(d);
        }
        if (rowDistances.length === 0) {
            rowDistances.push(totalLength * 0.5);
        }

        const swStart = this.getResolvedSidewalkWidth(0);
        const swEnd = this.getResolvedSidewalkWidth(1);
        const chStart = this.getResolvedCurbHeight(0);
        const chEnd = this.getResolvedCurbHeight(1);
        const dtStart = this.getResolvedBridgeDeckThickness(0);
        const dtEnd = this.getResolvedBridgeDeckThickness(1);

        const lateralFractions = this.getBridgePillarLateralFractions();
        const halfPillarWidth = Math.max(0.05, this.bridgePillarWidth * 0.5);

        for (const distance of rowDistances) {
            const sample = this.sampleEdgeAtDistance(edge, distance);
            if (!sample) continue;

            const sidewalkWidth = swStart + (swEnd - swStart) * sample.t;
            const curbHeight = chStart + (chEnd - chStart) * sample.t;
            const context: GeometryLineContext = {
                halfWidth: sample.halfWidth,
                sidewalkWidth,
                curbHeight,
                deckThickness: dtStart + (dtEnd - dtStart) * sample.t,
                leftDistance: 0,
                rightDistance: 0,
                maxEdgeLength: 1,
                crownHeight: this.getCrownAt(sample.t),
            };

            const outerHalfWidth = this.getBridgeOuterHalfWidth(context);
            const maxOffset = Math.max(0, outerHalfWidth - this.bridgePillarInset - halfPillarWidth);
            for (const lateralFraction of lateralFractions) {
                const offset = -maxOffset + 2 * maxOffset * lateralFraction;
                const pillarCenter = sample.origin.clone().add(sample.right.clone().multiplyScalar(offset));

                const deckTopY = sample.origin.y + this.getDeckTopHeightAtLateral(offset, context);
                const topY = deckTopY - Math.max(0.05, context.deckThickness);
                const terrainY = this.getTerrainHeightAtXZ(pillarCenter.x, pillarCenter.z, terrainMeshes);
                if (terrainY >= topY - 0.01) continue;

                if (this.bridgePillarShape === 'circular') {
                    this.addCircularPillarTriangles(
                        triangles,
                        pillarCenter,
                        topY,
                        terrainY,
                        halfPillarWidth,
                        Math.max(3, Math.round(this.bridgePillarSegments)),
                    );
                } else {
                    this.addBoxPillarTriangles(triangles, pillarCenter, topY, terrainY, halfPillarWidth);
                }
            }
        }

        this.applyUVTransformToTriangles('bridgePillars', triangles);

        return triangles;
    }

    private getBridgePillarLateralFractions(): number[] {
        const count = Math.max(1, Math.round(this.bridgePillarCount));
        if (count === 1) return [0.5];
        if (count === 2) return [0, 1];

        const fractions: number[] = [];
        for (let i = 0; i < count; i++) {
            fractions.push(i / (count - 1));
        }
        return fractions;
    }

    private sampleEdgeAtDistance(
        edge: ReturnType<Road['computeEdgeData']>,
        distance: number,
    ): { origin: THREE.Vector3; right: THREE.Vector3; halfWidth: number; t: number } | null {
        const pointCount = edge.points.length;
        if (pointCount < 2) return null;

        const target = THREE.MathUtils.clamp(distance, 0, edge.centerTotal);
        let segIndex = pointCount - 2;
        for (let i = 0; i < pointCount - 1; i++) {
            if (target <= edge.centerCumDist[i + 1]) {
                segIndex = i;
                break;
            }
        }

        const segStart = edge.centerCumDist[segIndex];
        const segEnd = edge.centerCumDist[segIndex + 1];
        const segLength = segEnd - segStart;
        const alpha = segLength > 1e-6 ? (target - segStart) / segLength : 0;

        const origin = edge.points[segIndex].clone().lerp(edge.points[segIndex + 1], alpha);
        const right = edge.rightVecs[segIndex].clone().lerp(edge.rightVecs[segIndex + 1], alpha);
        if (right.lengthSq() < 1e-8) {
            right.copy(edge.rightVecs[segIndex]);
        }
        right.normalize();

        const halfWidth = THREE.MathUtils.lerp(edge.halfWidths[segIndex], edge.halfWidths[segIndex + 1], alpha);
        const t = (segIndex + alpha) / (pointCount - 1);

        return { origin, right, halfWidth, t };
    }

    private getTerrainMeshes(): THREE.Object3D[] {
        const scene = container.resolve(SceneManager);
        return scene.getElements()
            .filter((element): element is Terrain => element instanceof Terrain)
            .map((terrain) => terrain.mesh);
    }

    private getTerrainHeightAtXZ(x: number, z: number, terrainMeshes: THREE.Object3D[]): number {
        if (terrainMeshes.length === 0) return 0;

        this.terrainRaycaster.set(new THREE.Vector3(x, 10000, z), new THREE.Vector3(0, -1, 0));
        this.terrainRaycaster.near = 0;
        this.terrainRaycaster.far = 20000;
        const hits = this.terrainRaycaster.intersectObjects(terrainMeshes, true);
        return hits.length > 0 ? hits[0].point.y : 0;
    }

    private addBoxPillarTriangles(
        out: Triangle[],
        center: THREE.Vector3,
        topY: number,
        bottomY: number,
        halfSize: number,
    ): void {
        const b0 = new THREE.Vector3(center.x - halfSize, bottomY, center.z - halfSize);
        const b1 = new THREE.Vector3(center.x + halfSize, bottomY, center.z - halfSize);
        const b2 = new THREE.Vector3(center.x + halfSize, bottomY, center.z + halfSize);
        const b3 = new THREE.Vector3(center.x - halfSize, bottomY, center.z + halfSize);

        const t0 = new THREE.Vector3(center.x - halfSize, topY, center.z - halfSize);
        const t1 = new THREE.Vector3(center.x + halfSize, topY, center.z - halfSize);
        const t2 = new THREE.Vector3(center.x + halfSize, topY, center.z + halfSize);
        const t3 = new THREE.Vector3(center.x - halfSize, topY, center.z + halfSize);

        this.pushPillarQuad(out, b0, b1, t1, t0, 0, 1, topY - bottomY);
        this.pushPillarQuad(out, b1, b2, t2, t1, 0, 1, topY - bottomY);
        this.pushPillarQuad(out, b2, b3, t3, t2, 0, 1, topY - bottomY);
        this.pushPillarQuad(out, b3, b0, t0, t3, 0, 1, topY - bottomY);
    }

    private addCircularPillarTriangles(
        out: Triangle[],
        center: THREE.Vector3,
        topY: number,
        bottomY: number,
        radius: number,
        segments: number,
    ): void {
        for (let i = 0; i < segments; i++) {
            const a0 = (i / segments) * Math.PI * 2;
            const a1 = ((i + 1) / segments) * Math.PI * 2;

            const b0 = new THREE.Vector3(center.x + Math.cos(a0) * radius, bottomY, center.z + Math.sin(a0) * radius);
            const b1 = new THREE.Vector3(center.x + Math.cos(a1) * radius, bottomY, center.z + Math.sin(a1) * radius);
            const t0 = new THREE.Vector3(center.x + Math.cos(a0) * radius, topY, center.z + Math.sin(a0) * radius);
            const t1 = new THREE.Vector3(center.x + Math.cos(a1) * radius, topY, center.z + Math.sin(a1) * radius);

            this.pushPillarQuad(out, b0, b1, t1, t0, i / segments, (i + 1) / segments, topY - bottomY);
        }
    }

    private pushPillarQuad(
        out: Triangle[],
        bottomA: THREE.Vector3,
        bottomB: THREE.Vector3,
        topB: THREE.Vector3,
        topA: THREE.Vector3,
        u0: number,
        u1: number,
        height: number,
    ): void {
        const vTop = 0;
        const vBottom = Math.max(0.01, height);
        out.push(new Triangle(bottomA, topB, bottomB,
            new THREE.Vector2(u0, vBottom),
            new THREE.Vector2(u1, vTop),
            new THREE.Vector2(u1, vBottom),
        ));
        out.push(new Triangle(bottomA, topA, topB,
            new THREE.Vector2(u0, vBottom),
            new THREE.Vector2(u0, vTop),
            new THREE.Vector2(u1, vTop),
        ));
    }

    private computeEdgeData() {
        const points = this.getBezierCurvePoints();
        const up = new THREE.Vector3(0, 1, 0);
        const halfWidthStart = this.getResolvedHalfWidth(0);
        const halfWidthEnd = this.getResolvedHalfWidth(1);

        const rightVecs: THREE.Vector3[] = [];
        const halfWidths: number[] = [];

        for (let i = 0; i < points.length; i++) {
            const t = i / (points.length - 1);
            halfWidths.push(halfWidthStart + (halfWidthEnd - halfWidthStart) * t);

            if (i === 0) rightVecs.push(this.getResolvedNodeBasis(0).right);
            else if (i === points.length - 1) rightVecs.push(this.getResolvedNodeBasis(1).right);
            else {
                const next = points[i + 1];
                const prev = points[i - 1];
                const direction = new THREE.Vector3().subVectors(next, prev).normalize();
                rightVecs.push(new THREE.Vector3().crossVectors(direction, up).normalize());
            }
        }

        // Compute left/right edge positions
        const leftEdgePos: THREE.Vector3[] = [];
        const rightEdgePos: THREE.Vector3[] = [];
        for (let i = 0; i < points.length; i++) {
            leftEdgePos.push(points[i].clone().add(rightVecs[i].clone().multiplyScalar(-halfWidths[i])));
            rightEdgePos.push(points[i].clone().add(rightVecs[i].clone().multiplyScalar(halfWidths[i])));
        }

        // Cumulative distances along each edge
        const leftCumDist = [0];
        const rightCumDist = [0];
        const centerCumDist = [0];
        for (let i = 1; i < points.length; i++) {
            leftCumDist.push(leftCumDist[i - 1] + leftEdgePos[i].distanceTo(leftEdgePos[i - 1]));
            rightCumDist.push(rightCumDist[i - 1] + rightEdgePos[i].distanceTo(rightEdgePos[i - 1]));
            centerCumDist.push(centerCumDist[i - 1] + points[i].distanceTo(points[i - 1]));
        }

        const leftTotal = leftCumDist[leftCumDist.length - 1];
        const rightTotal = rightCumDist[rightCumDist.length - 1];
        const maxEdgeLen = Math.min(leftTotal, rightTotal);

        // Normalize so both edges end at maxEdgeLen
        for (let i = 0; i < leftCumDist.length; i++) {
            leftCumDist[i] = leftTotal > 0 ? (leftCumDist[i] / leftTotal) * maxEdgeLen : 0;
        }
        for (let i = 0; i < rightCumDist.length; i++) {
            rightCumDist[i] = rightTotal > 0 ? (rightCumDist[i] / rightTotal) * maxEdgeLen : 0;
        }

        const centerTotal = centerCumDist[centerCumDist.length - 1];

        return { points, rightVecs, halfWidths, leftCumDist, rightCumDist, centerCumDist, centerTotal, maxEdgeLen };
    }

}
