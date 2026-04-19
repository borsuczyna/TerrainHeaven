import * as THREE from 'three';
import WorldElement, { type NodeBasis } from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import type { PropertyDefinition, SectionItem } from '../editor/Properties';

export default class Intersection extends WorldElement {
    public width: number = 3;
    public length: number = 3;
    private _nodeCount: number = 4;

    public override getWidth(): number { return this.width; }

    constructor(position: THREE.Vector3, nodeCount: number = 4) {
        super();
        this._nodeCount = nodeCount;
        this.rebuildNodes(position);
    }

    public get nodeCount(): number { return this._nodeCount; }
    public set nodeCount(value: number) {
        if (value < 2) value = 2;
        if (value === this._nodeCount) return;
        const center = this.getCenter();
        this._nodeCount = value;
        this.rebuildNodes(center);
        this.update();
    }

    private getCenter(): THREE.Vector3 {
        if (this.nodes.length === 0) return new THREE.Vector3();
        const center = new THREE.Vector3();
        for (const node of this.nodes) {
            center.add(node.mesh.position);
        }
        return center.divideScalar(this.nodes.length);
    }

    private rebuildNodes(center: THREE.Vector3): void {
        // Disconnect from all connected elements (both sides)
        this.disconnectAll();

        for (const node of this.nodes) {
            this.mesh.remove(node.mesh);
            if (node.parent === this) node.parent = null;
        }
        this.nodes = [];

        // Create nodes evenly spaced around center
        for (let i = 0; i < this._nodeCount; i++) {
            const angle = (i / this._nodeCount) * Math.PI * 2;
            const radius = this.width * 1;
            const offset = new THREE.Vector3(
                Math.cos(angle) * radius,
                0,
                Math.sin(angle) * radius,
            );
            const pos = center.clone().add(offset);
            this.setNode(i, new WorldNode(pos, Config.editor.nodeColor));
        }
    }

    public getNodeBasis(index: number): NodeBasis {
        const center = this.getCenter();
        const nodePos = this.nodes[index].mesh.position;
        const up = new THREE.Vector3(0, 1, 0);

        // Forward points outward from center
        const forward = new THREE.Vector3().subVectors(nodePos, center).normalize();
        if (forward.lengthSq() < 0.001) {
            forward.set(1, 0, 0);
        }

        const right = new THREE.Vector3().crossVectors(forward, up).normalize();
        return { forward, right, up };
    }

    public connectWith(thisNodeIndex: number, other: WorldElement, otherNodeIndex: number): void {
        this.connect(thisNodeIndex, other, otherNodeIndex);
        this.update();
        other.update();
    }

    public getProperties(): PropertyDefinition {
        const self = this;
        const makeNodeVec3 = (label: string, node: WorldNode) => ({
            type: 'vector3' as const,
            label,
            get: () => node.mesh.position.clone(),
            set: (v: THREE.Vector3) => { node.update(v); },
        });

        const nodeSections = this.nodes.map((node, i) => {
            const props: SectionItem[] = [makeNodeVec3('Position', node)];
            if (this.isConnected(i)) {
                props.push({
                    type: 'button' as const,
                    label: 'Disconnect',
                    onClick: () => { self.disconnect(i); self.onPropertiesChanged?.(); },
                });
            }
            return { label: `Node ${i}`, properties: props };
        });

        return {
            title: 'Intersection',
            icon: '&#11021;',
            sections: [
                {
                    label: 'Intersection',
                    properties: [
                        {
                            type: 'number' as const,
                            label: 'Width',
                            get: () => self.width,
                            set: (v: number) => { self.width = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Length',
                            get: () => self.length,
                            set: (v: number) => { self.length = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Nodes',
                            get: () => self.nodeCount,
                            set: (v: number) => { self.nodeCount = Math.max(2, Math.round(v)); self.onPropertiesChanged?.(); },
                            min: 2,
                            step: 1,
                        },
                    ],
                },
                ...nodeSections,
            ],
        };
    }

    protected getTriangles(): Triangle[] {
        const triangles: Triangle[] = [];
        const center = this.getCenter();

        // For each node, compute left/right edge points using resolved basis + half-width
        const leftEdges: THREE.Vector3[] = [];
        const rightEdges: THREE.Vector3[] = [];

        for (let i = 0; i < this._nodeCount; i++) {
            const nodePos = this.nodes[i].mesh.position;
            const basis = this.getResolvedNodeBasis(i);
            const hw = this.getResolvedHalfWidth(i);
            leftEdges.push(nodePos.clone().sub(basis.right.clone().multiplyScalar(hw)));
            rightEdges.push(nodePos.clone().add(basis.right.clone().multiplyScalar(hw)));
        }

        for (let i = 0; i < this._nodeCount; i++) {
            const nextIdx = (i + 1) % this._nodeCount;

            // Road mouth quad at node i (two triangles)
            triangles.push(new Triangle(center.clone(), rightEdges[i].clone(), leftEdges[i].clone()));

            // Fill gap between node i's right edge and next node's left edge
            triangles.push(new Triangle(center.clone(), leftEdges[nextIdx].clone(), rightEdges[i].clone()));
        }

        return triangles;
    }
}
