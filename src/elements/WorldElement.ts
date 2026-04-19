import * as THREE from 'three';
import type Triangle from './Vertex';
import type WorldNode from './WorldNode';
import WireframeManager from '../editor/WireframeManager';
import type { PropertyDefinition } from '../editor/Properties';

export interface NodeBasis {
    forward: THREE.Vector3;
    right: THREE.Vector3;
    up: THREE.Vector3;
}

interface Connection {
    element: WorldElement;
    nodeIndex: number;
}

export default abstract class WorldElement {
    public readonly mesh: THREE.Mesh = new THREE.Mesh(undefined, new THREE.MeshStandardMaterial());
    protected nodes: WorldNode[] = [];
    protected connections: Map<number, Connection[]> = new Map();

    constructor() {
        WireframeManager.register(this.mesh);
        this.mesh.userData.worldElement = this;
    }

    public getNode(index: number): WorldNode {
        return this.nodes[index];
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

    public connect(thisNodeIndex: number, other: WorldElement, otherNodeIndex: number): void {
        this.setNode(thisNodeIndex, other.getNode(otherNodeIndex));

        if (!this.connections.has(thisNodeIndex)) this.connections.set(thisNodeIndex, []);
        this.connections.get(thisNodeIndex)!.push({ element: other, nodeIndex: otherNodeIndex });

        if (!other.connections.has(otherNodeIndex)) other.connections.set(otherNodeIndex, []);
        other.connections.get(otherNodeIndex)!.push({ element: this, nodeIndex: thisNodeIndex });
    }

    public abstract getNodeBasis(index: number): NodeBasis;

    public abstract getProperties(): PropertyDefinition;

    public getWidth(): number { return 0; }

    public getResolvedHalfWidth(index: number): number {
        const conns = this.connections.get(index);
        if (!conns || conns.length === 0) return this.getWidth() / 2;
        let total = this.getWidth();
        for (const conn of conns) total += conn.element.getWidth();
        return total / (conns.length + 1) / 2;
    }

    public setSelected(selected: boolean): void {
        const mat = this.mesh.material as THREE.MeshStandardMaterial;
        if (!mat?.emissive) return;
        if (selected) {
            mat.emissive.setHex(0x0044ff);
            mat.emissiveIntensity = 0.5;
        } else {
            mat.emissive.setHex(0x000000);
            mat.emissiveIntensity = 1;
        }
    }

    public getResolvedNodeBasis(index: number): NodeBasis {
        const basis = this.getNodeBasis(index);
        const conns = this.connections.get(index);
        if (!conns || conns.length === 0) return basis;

        const avgRight = basis.right.clone();
        for (const conn of conns) {
            avgRight.add(conn.element.getNodeBasis(conn.nodeIndex).right);
        }
        avgRight.normalize();

        const forward = new THREE.Vector3().crossVectors(basis.up, avgRight).normalize();
        const right = new THREE.Vector3().crossVectors(forward, basis.up).normalize();

        return { forward, right, up: basis.up.clone() };
    }

    public update(): void {
        const triangles = this.getTriangles();
        this.setTriangles(triangles);
    }

    protected abstract getTriangles(): Triangle[];

    private setTriangles(triangles: Triangle[]): void {
        const geometry = new THREE.BufferGeometry();
        const positionArray = new Float32Array(triangles.length * 9);
        triangles.forEach((triangle, index) => {
            positionArray.set(triangle.toArray(), index * 9);
        });

        geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
        geometry.computeVertexNormals();
        this.mesh.geometry = geometry;
    }
}