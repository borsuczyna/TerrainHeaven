import * as THREE from 'three';
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

interface Connection {
    element: WorldElement;
    nodeIndex: number;
}

export default abstract class WorldElement {
    public readonly mesh: THREE.Mesh = new THREE.Mesh(undefined, new THREE.MeshStandardMaterial());
    protected nodes: WorldNode[] = [];
    public connections: Map<number, Connection> = new Map();
    public onPropertiesChanged: (() => void) | null = null;

    constructor() {
        WireframeManager.register(this.mesh);
        this.mesh.userData.worldElement = this;
    }

    public getNode(index: number): WorldNode {
        return this.nodes[index];
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

    public getWidth(): number { return 0; }
    public getSidewalkWidth(): number { return 0; }
    public getCurbHeight(): number { return 0; }

    public getResolvedHalfWidth(index: number): number {
        const conn = this.connections.get(index);
        if (!conn) return this.getWidth() / 2;
        return (this.getWidth() + conn.element.getWidth()) / 2 / 2;
    }

    public getResolvedSidewalkWidth(index: number): number {
        const conn = this.connections.get(index);
        if (!conn) return this.getSidewalkWidth();
        return (this.getSidewalkWidth() + conn.element.getSidewalkWidth()) / 2;
    }

    public getResolvedCurbHeight(index: number): number {
        const conn = this.connections.get(index);
        if (!conn) return this.getCurbHeight();
        return (this.getCurbHeight() + conn.element.getCurbHeight()) / 2;
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