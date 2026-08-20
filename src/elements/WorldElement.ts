import * as THREE from 'three';
import { container } from 'tsyringe';
import type Triangle from './Vertex';
import WorldNode from './WorldNode';
import WireframeManager from '../editor/WireframeManager';
import Config from '../utils/Config';
import type { PropertyDefinition } from '../editor/Properties';

export interface NodeBasis {
    forward: THREE.Vector3;
    right: THREE.Vector3;
    up: THREE.Vector3;
}

export interface GeometryGroup {
    name: string;
    triangles: Triangle[];
}

export interface UVTransform {
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
}

export interface OccupiedTriangle {
    a: THREE.Vector3;
    b: THREE.Vector3;
    c: THREE.Vector3;
}

export interface ElementData {
    type: 'road' | 'intersection' | 'terrain' | 'terrainCutSpline' | 'river';
    id: number;
    nodes: { x: number; y: number; z: number }[];
    textures: Record<string, string>;
    textureRotations: Record<string, number>;
    uvTransforms?: Record<string, UVTransform>;
    // Road-specific
    width?: number;
    lanes?: number;
    divisions?: number;
    edgeType?: string;
    sidewalkWidth?: number;
    curbHeight?: number;
    roadCrown?: number;
    curvePointA?: { x: number; y: number; z: number } | null;
    curvePointB?: { x: number; y: number; z: number } | null;
    bridgeEnabled?: boolean;
    bridgePillarShape?: string;
    bridgePillarSegments?: number;
    bridgePillarDistance?: number;
    bridgePillarCount?: number;
    bridgePillarWidth?: number;
    bridgePillarInset?: number;
    bridgeDeckThickness?: number;
    // Intersection-specific
    length?: number;
    nodeCount?: number;
    roadTexWidth?: number;
    roadTexHeight?: number;
    roadTexOffsetX?: number;
    roadTexOffsetY?: number;
    // Terrain-specific
    terrainWidth?: number;
    terrainLength?: number;
    terrainGridEnabled?: boolean;
    terrainGridSize?: number;
    terrainMeshDetail?: number;
    terrainTriangleLimit?: number;
    terrainSmoothingEnabled?: boolean;
    terrainSmoothingRadius?: number;
    terrainMaxSlope?: number;
    // Terrain cut spline-specific
    terrainCutDistance?: number;
}

interface Connection {
    element: WorldElement;
    nodeIndex: number;
}

export default abstract class WorldElement {
    public readonly mesh: THREE.Mesh = new THREE.Mesh(undefined, [new THREE.MeshStandardMaterial()]);
    protected nodes: WorldNode[] = [];
    public connections: Map<number, Connection> = new Map();
    public onPropertiesChanged: (() => void) | null = null;
    public onGeometryChanged: (() => void) | null = null;
    private groupNames: string[] = [];
    private groupTextures: Map<string, THREE.Texture> = new Map();
    private groupTexturePaths: Map<string, string> = new Map();
    public textureRotations: Map<string, number> = new Map();
    private isSelected: boolean = false;

    constructor() {
        container.resolve(WireframeManager).register(this.mesh);
        this.mesh.userData.worldElement = this;
        // Large terrain/road meshes receiving shadows is cheap; casting them all is not.
        // Elements that materially need to cast a shadow opt in explicitly.
        this.mesh.castShadow = false;
        this.mesh.receiveShadow = true;
    }

    public getNode(index: number): WorldNode {
        return this.nodes[index];
    }

    public getChildWorldNodes(): WorldNode[] {
        const out: WorldNode[] = [];
        this.mesh.traverse((obj) => {
            const node = obj.userData.worldNode as WorldNode | undefined;
            if (node) out.push(node);
        });
        return out;
    }

    public getTransformWorldNodes(): WorldNode[] {
        const out: WorldNode[] = [];
        const seen = new Set<WorldNode>();

        for (const node of this.nodes) {
            if (!node || seen.has(node)) continue;
            seen.add(node);
            out.push(node);
        }

        for (const node of this.getChildWorldNodes()) {
            if (seen.has(node)) continue;
            seen.add(node);
            out.push(node);
        }

        return out;
    }

    public getAffectedElementsForNode(node: WorldNode): WorldElement[] {
        const affected = new Set<WorldElement>();

        if (node.parent) {
            affected.add(node.parent);
        }

        let referencesNode = false;
        for (let index = 0; index < this.nodes.length; index++) {
            if (this.nodes[index] !== node) continue;
            referencesNode = true;
            affected.add(this);

            const connection = this.connections.get(index);
            if (connection) {
                affected.add(connection.element);
            }
        }

        if (!referencesNode && node.parent === this) {
            affected.add(this);
        }

        return [...affected];
    }

    public getNodeIndex(node: WorldNode): number {
        return this.nodes.indexOf(node);
    }

    public setNode(index: number, node: WorldNode): void {
        const old = this.nodes[index];
        if (old) {
            this.mesh.remove(old.mesh);
            if (old.parent === this) old.parent = null;
        }
        this.nodes[index] = node;
        node.parent = this;
        this.mesh.add(node.mesh);
    }

    public isConnected(nodeIndex: number): boolean {
        return this.connections.has(nodeIndex);
    }

    public connect(thisNodeIndex: number, other: WorldElement, otherNodeIndex: number): boolean {
        if (this.connections.has(thisNodeIndex) || other.connections.has(otherNodeIndex)) return false;
        this.setNode(thisNodeIndex, other.getNode(otherNodeIndex));
        this.connections.set(thisNodeIndex, { element: other, nodeIndex: otherNodeIndex });
        other.connections.set(otherNodeIndex, { element: this, nodeIndex: thisNodeIndex });
        return true;
    }

    public disconnect(nodeIndex: number): void {
        const conn = this.connections.get(nodeIndex);
        if (!conn) return;
        conn.element.connections.delete(conn.nodeIndex);
        this.connections.delete(nodeIndex);
        // The shared node — setNode will orphan it, so save a reference
        const sharedNode = this.nodes[nodeIndex];
        // Give this element its own new node
        const pos = sharedNode.mesh.position.clone();
        this.setNode(nodeIndex, new WorldNode(pos, Config.editor.nodeColor));
        // Re-parent the shared node back to the other element
        sharedNode.parent = conn.element;
        conn.element.mesh.add(sharedNode.mesh);
        this.update();
        conn.element.update();
    }

    public disconnectAll(): void {
        for (const [, conn] of this.connections) {
            // Remove matching entry from the other element
            for (const [otherIdx, otherConn] of conn.element.connections) {
                if (otherConn.element === this) {
                    conn.element.connections.delete(otherIdx);
                }
            }
        }
        this.connections.clear();
    }

    public abstract getNodeBasis(index: number): NodeBasis;

    public abstract getProperties(): PropertyDefinition;

    public abstract getOccupiedArea(): OccupiedTriangle[];

    public abstract serialize(id: number): ElementData;

    protected collectTextureMaps(): { textures: Record<string, string>; textureRotations: Record<string, number> } {
        const textures: Record<string, string> = {};
        const textureRotations: Record<string, number> = {};
        for (const groupName of this.getGroupNames()) {
            const tex = this.getGroupTexture(groupName);
            const sourcePath = this.groupTexturePaths.get(groupName) ?? tex?.userData.sourcePath;
            if (typeof sourcePath === 'string' && sourcePath) textures[groupName] = sourcePath;
            const rot = this.textureRotations.get(groupName);
            if (rot) textureRotations[groupName] = rot;
        }
        return { textures, textureRotations };
    }

    /** Override to return group names that support UV editing */
    public getUVGroups(): string[] { return []; }

    /** Override to get current UV transform for a group */
    public getUVTransform(_group: string): UVTransform {
        return { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    }

    /** Override to set UV transform for a group */
    public setUVTransform(_group: string, _transform: UVTransform): void {}

    public getWidth(): number { return 0; }
    public getSidewalkWidth(): number { return 0; }
    public getCurbHeight(): number { return 0; }
    public isTerrainSurface(): boolean { return false; }
    public dependsOnTerrainSurface(): boolean { return false; }

    public getResolvedHalfWidth(index: number): number {
        const conn = this.connections.get(index);
        if (!conn) return this.getWidth() / 2;
        return (this.getWidth() + conn.element.getWidth()) / 2 / 2;
    }

    public getResolvedSidewalkWidth(index: number): number {
        const conn = this.connections.get(index);
        if (!conn) return this.getSidewalkWidth();
        const ownWidth = this.getSidewalkWidth();
        const otherWidth = conn.element.getSidewalkWidth();
        if (ownWidth <= 0 || otherWidth <= 0) return 0;
        return (ownWidth + otherWidth) / 2;
    }

    public getResolvedCurbHeight(index: number): number {
        const conn = this.connections.get(index);
        if (!conn) return this.getCurbHeight();
        if (this.getSidewalkWidth() <= 0 || conn.element.getSidewalkWidth() <= 0) return 0;
        return (this.getCurbHeight() + conn.element.getCurbHeight()) / 2;
    }

    public setSelected(selected: boolean): void {
        this.isSelected = selected;
        const mats = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
        for (const mat of mats) {
            this.applySelectionMaterialState(mat as THREE.MeshStandardMaterial);
        }
    }

    private applySelectionMaterialState(material: THREE.MeshStandardMaterial): void {
        if (!material) return;

        const baseColor = this.getBaseMaterialColor(material);
        if (this.isSelected) {
            material.color.copy(baseColor).lerp(new THREE.Color(0x4d8dff), 0.45);
            material.emissive.setHex(0x173d91);
            material.emissiveIntensity = 0.35;
        } else {
            material.color.copy(baseColor);
            material.emissive.setHex(0x000000);
            material.emissiveIntensity = 0;
        }

        material.needsUpdate = true;
    }

    private getBaseMaterialColor(material: THREE.MeshStandardMaterial): THREE.Color {
        const storedBase = material.userData.baseColor;
        if (storedBase instanceof THREE.Color) {
            return storedBase;
        }

        const baseColor = material.color.clone();
        material.userData.baseColor = baseColor;
        return baseColor;
    }

    public translate(delta: THREE.Vector3): void {
        const childNodes = this.getTransformWorldNodes();
        if (childNodes.length === 0) {
            this.mesh.position.add(delta);
            this.update();
            return;
        }

        const moved = new Set<WorldNode>();
        const touched = new Set<WorldElement>();
        for (const node of childNodes) {
            if (moved.has(node)) continue;
            moved.add(node);

            const worldPos = new THREE.Vector3();
            node.mesh.getWorldPosition(worldPos);
            worldPos.add(delta);

            if (node.mesh.parent) {
                node.mesh.position.copy(node.mesh.parent.worldToLocal(worldPos));
            } else {
                node.mesh.position.copy(worldPos);
            }

            for (const element of this.getAffectedElementsForNode(node)) {
                touched.add(element);
            }
        }

        if (touched.size === 0) {
            this.update();
            return;
        }

        for (const element of touched) {
            element.update();
        }
    }

    public canRotate(): boolean {
        return this.getTransformWorldNodes().length > 0;
    }

    public rotateAround(pivot: THREE.Vector3, deltaRotation: THREE.Quaternion): void {
        const childNodes = this.getTransformWorldNodes();
        if (childNodes.length === 0) {
            return;
        }

        const moved = new Set<WorldNode>();
        const touched = new Set<WorldElement>();
        for (const node of childNodes) {
            if (moved.has(node)) continue;
            moved.add(node);

            const worldPos = new THREE.Vector3();
            node.mesh.getWorldPosition(worldPos);
            worldPos.sub(pivot).applyQuaternion(deltaRotation).add(pivot);

            if (node.mesh.parent) {
                node.mesh.position.copy(node.mesh.parent.worldToLocal(worldPos));
            } else {
                node.mesh.position.copy(worldPos);
            }

            for (const element of this.getAffectedElementsForNode(node)) {
                touched.add(element);
            }
        }

        for (const element of touched) {
            element.update();
        }
    }

    public getResolvedNodeBasis(index: number): NodeBasis {
        const basis = this.getNodeBasis(index);
        const conn = this.connections.get(index);
        if (!conn) return basis;

        const connBasis = conn.element.getNodeBasis(conn.nodeIndex);
        const avgRight = basis.right.clone();
        // If forwards point opposite (e.g. end-to-end), the connected
        // right is flipped — negate it to keep sides consistent
        if (basis.forward.dot(connBasis.forward) < 0) {
            avgRight.sub(connBasis.right);
        } else {
            avgRight.add(connBasis.right);
        }
        avgRight.normalize();

        const forward = new THREE.Vector3().crossVectors(basis.up, avgRight).normalize();
        const right = new THREE.Vector3().crossVectors(forward, basis.up).normalize();

        return { forward, right, up: basis.up.clone() };
    }

    public update(): void {
        const groups = this.getGeometry();
        this.setGeometry(groups);
        this.onGeometryChanged?.();
    }

    public dispose(): void {
        container.resolve(WireframeManager).unregister(this.mesh);
        this.mesh.geometry.dispose();
        const materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
        for (const material of materials) material.dispose();
        for (const texture of new Set(this.groupTextures.values())) texture.dispose();
        this.groupTextures.clear();
        this.groupTexturePaths.clear();

        const nodes = new Set(this.getChildWorldNodes());
        for (const node of nodes) node.dispose();
        this.nodes = [];
        this.connections.clear();
        this.onPropertiesChanged = null;
        this.onGeometryChanged = null;
    }

    protected abstract getGeometry(): GeometryGroup[];

    public getGroupNameAtFace(faceIndex: number): string | null {
        const geometry = this.mesh.geometry;
        if (!geometry) return null;
        const vertexIndex = faceIndex * 3;
        for (const group of geometry.groups) {
            if (vertexIndex >= group.start && vertexIndex < group.start + group.count) {
                return this.groupNames[group.materialIndex ?? 0] ?? null;
            }
        }
        return this.groupNames[0] ?? null;
    }

    public getGroupTexture(groupName: string): THREE.Texture | undefined {
        return this.groupTextures.get(groupName);
    }

    public setGroupTextureReference(groupName: string, sourcePath: string): void {
        if (sourcePath) this.groupTexturePaths.set(groupName, sourcePath);
    }

    public getGroupTextureReferences(): ReadonlyMap<string, string> {
        return this.groupTexturePaths;
    }

    public getGroupNames(): string[] {
        return this.groupNames;
    }

    public setGroupTexture(groupName: string, texture: THREE.Texture, sourcePath?: string): void {
        const previous = this.groupTextures.get(groupName);
        this.groupTextures.set(groupName, texture);
        const resolvedPath = sourcePath ?? texture.userData.sourcePath;
        if (typeof resolvedPath === 'string' && resolvedPath) {
            this.groupTexturePaths.set(groupName, resolvedPath);
            texture.userData.sourcePath = resolvedPath;
        }
        this.applyTextureRotation(groupName, texture);
        // Update existing material if already built
        const mats = this.mesh.material;
        if (Array.isArray(mats)) {
            const idx = this.groupNames.indexOf(groupName);
            if (idx >= 0 && mats[idx]) {
                const m = mats[idx] as THREE.MeshStandardMaterial;
                m.map = texture;
                m.needsUpdate = true;
            }
        }
        if (previous && previous !== texture) previous.dispose();
    }

    public setTextureRotation(groupName: string, degrees: number): void {
        this.textureRotations.set(groupName, degrees);
        const tex = this.groupTextures.get(groupName);
        if (tex) {
            this.applyTextureRotation(groupName, tex);
            // Force material update
            const mats = this.mesh.material;
            if (Array.isArray(mats)) {
                const idx = this.groupNames.indexOf(groupName);
                if (idx >= 0 && mats[idx]) {
                    (mats[idx] as THREE.MeshStandardMaterial).needsUpdate = true;
                }
            }
        }
    }

    private applyTextureRotation(groupName: string, tex: THREE.Texture): void {
        const deg = this.textureRotations.get(groupName) ?? 0;
        tex.rotation = (deg * Math.PI) / 180;
        tex.center.set(0.5, 0.5);
    }

    private setGeometry(groups: GeometryGroup[]): void {
        const oldGeometry = this.mesh.geometry;
        const oldMaterials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
        const geometry = new THREE.BufferGeometry();
        const allTriangles: Triangle[] = [];
        const groupInfos: { name: string; start: number; count: number }[] = [];

        let vertexOffset = 0;
        for (const group of groups) {
            const count = group.triangles.length * 3;
            groupInfos.push({ name: group.name, start: vertexOffset, count });
            allTriangles.push(...group.triangles);
            vertexOffset += count;
        }

        const totalVerts = allTriangles.length * 3;
        const positionArray = new Float32Array(totalVerts * 3);
        const uvArray = new Float32Array(totalVerts * 2);

        allTriangles.forEach((tri, idx) => {
            positionArray.set(tri.toArray(), idx * 9);
            uvArray.set(tri.uvToArray(), idx * 6);
        });

        geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
        geometry.computeVertexNormals();

        this.groupNames = [];
        const materials: THREE.MeshStandardMaterial[] = [];
        for (let i = 0; i < groupInfos.length; i++) {
            const info = groupInfos[i];
            geometry.addGroup(info.start, info.count, i);
            this.groupNames.push(info.name);
            const mat = new THREE.MeshStandardMaterial();
            mat.userData.baseColor = mat.color.clone();
            const tex = this.groupTextures.get(info.name);
            if (tex) {
                this.applyTextureRotation(info.name, tex);
                mat.map = tex;
            }
            mat.wireframe = container.resolve(WireframeManager).isEnabled();
            this.applySelectionMaterialState(mat);
            materials.push(mat);
        }

        this.mesh.geometry = geometry;
        this.mesh.material = materials;

        oldGeometry.dispose();
        for (const material of oldMaterials) material.dispose();
    }
}
