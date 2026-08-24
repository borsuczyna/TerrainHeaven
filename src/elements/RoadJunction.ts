import * as THREE from 'three';
import WorldElement, {
    type ElementData,
    type GeometryGroup,
    type NodeBasis,
    type OccupiedTriangle,
    type UVTransform,
} from './WorldElement';
import Triangle from './Vertex';
import type { PropertyDefinition } from '../editor/Properties';

export interface JunctionArm {
    // The road's own actual endpoint, world-space - the fan always reaches exactly to
    // this point (never a fixed radius), so it meets the road with no gap or overlap
    // regardless of how many arms meet here or at what angles.
    point: THREE.Vector3;
    // Unit, horizontal, pointing away from the junction and into the road.
    outward: THREE.Vector3;
    halfWidth: number;
    sidewalkWidth: number;
    curbHeight: number;
}

const DEFAULT_UV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

// A paved triangle fan auto-built wherever 3+ roads meet (see RoadJunctionManager) -
// never placed, moved, or resized directly by the user. It has no nodes of its own and is
// fully rebuilt from scratch by setArms()+update() whenever the manager detects one of its
// participating roads' endpoints has moved. Cuts/blends into terrain through the exact
// same generic WorldElement.getOccupiedArea()/cutsTerrainSurface() pipeline every other
// ground element (Road, Building, ...) already uses - nothing terrain-side is
// junction-specific.
export default class RoadJunction extends WorldElement {
    private arms: JunctionArm[] = [];
    private roadUv: UVTransform = { ...DEFAULT_UV };
    private sidewalkUv: UVTransform = { ...DEFAULT_UV };

    public setArms(arms: JunctionArm[]): void {
        this.arms = arms;
    }

    public getCenter(): THREE.Vector3 {
        const center = new THREE.Vector3();
        for (const arm of this.arms) center.add(arm.point);
        return this.arms.length > 0 ? center.multiplyScalar(1 / this.arms.length) : center;
    }

    public override getNodeBasis(_index: number): NodeBasis {
        return { forward: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) };
    }

    public override getUVGroups(): string[] {
        return ['road', 'sidewalk'];
    }

    public override getUVTransform(group: string): UVTransform {
        if (group === 'road') return { ...this.roadUv };
        if (group === 'sidewalk') return { ...this.sidewalkUv };
        return super.getUVTransform(group);
    }

    public override setUVTransform(group: string, transform: UVTransform): void {
        if (group !== 'road' && group !== 'sidewalk') { super.setUVTransform(group, transform); return; }
        const next: UVTransform = {
            offsetX: Number.isFinite(transform.offsetX) ? transform.offsetX : 0,
            offsetY: Number.isFinite(transform.offsetY) ? transform.offsetY : 0,
            scaleX: Number.isFinite(transform.scaleX) ? Math.max(0.05, transform.scaleX) : 1,
            scaleY: Number.isFinite(transform.scaleY) ? Math.max(0.05, transform.scaleY) : 1,
        };
        if (group === 'road') this.roadUv = next; else this.sidewalkUv = next;
        this.update();
    }

    public override getOccupiedArea(): OccupiedTriangle[] {
        const result: OccupiedTriangle[] = [];
        for (const group of this.getGeometry()) {
            for (const tri of group.triangles) result.push({ a: tri.a.clone(), b: tri.b.clone(), c: tri.c.clone() });
        }
        return result;
    }

    // A road's own top surface always faces +Y - build every fan/strip triangle with that
    // same guaranteed winding regardless of the arms' own left/right handedness, the same
    // defensive correction Building.ts's triangulatePolygon uses for the same kind of
    // footprint-to-3D mapping.
    private addTriangle(out: Triangle[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, uv: UVTransform, scale: number): void {
        const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        const uvFor = (p: THREE.Vector3): THREE.Vector2 => new THREE.Vector2(p.x * scale * uv.scaleX + uv.offsetX, p.z * scale * uv.scaleY + uv.offsetY);
        if (normal.y < 0) [b, c] = [c, b];
        out.push(new Triangle(a, b, c, uvFor(a), uvFor(b), uvFor(c)));
    }

    protected override getGeometry(): GeometryGroup[] {
        const road: Triangle[] = [];
        const sidewalk: Triangle[] = [];
        if (this.arms.length < 3) return [{ name: 'road', triangles: road }];

        const center = this.getCenter();
        // Sorted by angle around the center so the fan's "fill" triangles (between one
        // arm's left edge and the next arm's right edge) connect genuinely adjacent arms
        // rather than whatever order they happened to be detected in.
        const sorted = [...this.arms].sort((a, b) => {
            const angleA = Math.atan2(a.point.z - center.z, a.point.x - center.x);
            const angleB = Math.atan2(b.point.z - center.z, b.point.x - center.x);
            return angleA - angleB;
        });

        const right = (outward: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(-outward.z, 0, outward.x);
        const edges = sorted.map((arm) => {
            const r = right(arm.outward).multiplyScalar(arm.halfWidth);
            return { arm, rightEdge: arm.point.clone().sub(r), leftEdge: arm.point.clone().add(r) };
        });

        const n = edges.length;
        for (let i = 0; i < n; i++) {
            const a = edges[i];
            const b = edges[(i + 1) % n];
            this.addTriangle(road, center, a.rightEdge, a.leftEdge, this.roadUv, 0.2);
            this.addTriangle(road, center, b.rightEdge, a.leftEdge, this.roadUv, 0.2);

            // Sidewalk strip between two adjacent arms, only where both actually have one -
            // mirrors WorldElement.getResolvedCurbHeight zeroing the curb whenever either
            // connected side lacks a sidewalk, the same "the narrower side wins" rule Road
            // itself already applies at an ordinary two-road junction.
            const sw = Math.min(a.arm.sidewalkWidth, b.arm.sidewalkWidth);
            if (sw <= 0) continue;
            const curb = Math.min(a.arm.curbHeight, b.arm.curbHeight);
            const outA = a.leftEdge.clone().add(right(a.arm.outward).multiplyScalar(sw));
            const outB = b.rightEdge.clone().add(right(b.arm.outward).multiplyScalar(-sw));
            outA.y += curb;
            outB.y += curb;
            const topA = a.leftEdge.clone().setY(a.leftEdge.y + curb);
            const topB = b.rightEdge.clone().setY(b.rightEdge.y + curb);
            // Curb face (vertical) then the sidewalk's own top face.
            this.addTriangle(sidewalk, a.leftEdge, b.rightEdge, topB, this.sidewalkUv, 0.5);
            this.addTriangle(sidewalk, a.leftEdge, topB, topA, this.sidewalkUv, 0.5);
            this.addTriangle(sidewalk, topA, topB, outB, this.sidewalkUv, 0.5);
            this.addTriangle(sidewalk, topA, outB, outA, this.sidewalkUv, 0.5);
        }

        const groups: GeometryGroup[] = [{ name: 'road', triangles: road }];
        if (sidewalk.length > 0) groups.push({ name: 'sidewalk', triangles: sidewalk });
        return groups;
    }

    public getExportGeometry(_lodIndex: number): GeometryGroup[] {
        return this.getGeometry();
    }

    // Auto-derived, never actually written to a save file - ProjectSerializer.save()
    // filters RoadJunction instances out of the element list before calling serialize() on
    // anything, and RoadJunctionManager rebuilds every junction fresh from the current
    // roads right after a project loads (and continuously while editing). This exists only
    // as a harmless fallback so nothing crashes if serialize() is ever reached anyway (e.g.
    // a future generic "export all elements" pass) - 'roadJunction' has no deserialize
    // case, so loading one back is a silent no-op, same as any other unrecognized type.
    public override serialize(id: number): ElementData {
        return { type: 'roadJunction', id, nodes: [], textures: {}, textureRotations: {} };
    }

    public override getProperties(): PropertyDefinition {
        return {
            title: 'Road Junction',
            icon: '&#128937;',
            sections: [{
                label: 'Info',
                properties: [{
                    type: 'button',
                    label: `${this.arms.length} roads meet here (auto-generated)`,
                    onClick: () => {},
                }],
            }],
        };
    }
}
