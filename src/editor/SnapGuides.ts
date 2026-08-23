import * as THREE from 'three';

export interface AxisGuide {
    axis: 'x' | 'z';
    reference: THREE.Vector3;
}

export interface AxisSnapResult {
    point: THREE.Vector3;
    guides: AxisGuide[];
}

const DEFAULT_THRESHOLD = 0.4;

// Figma/CAD-style alignment guides: if the candidate point's X (or Z) nearly matches an
// existing reference point's, snap that one axis exactly onto it and report a guide to
// draw between them. The other axis is left alone, so this only ever pulls the point onto
// a straight line through a real existing point - never both axes into a corner at once.
export function snapToAxisAlignment(
    point: THREE.Vector3,
    references: THREE.Vector3[],
    threshold: number = DEFAULT_THRESHOLD,
): AxisSnapResult {
    const result = point.clone();
    const guides: AxisGuide[] = [];
    let bestX: { distance: number; reference: THREE.Vector3 } | null = null;
    let bestZ: { distance: number; reference: THREE.Vector3 } | null = null;

    for (const reference of references) {
        const dx = Math.abs(reference.x - point.x);
        if (dx <= threshold && (!bestX || dx < bestX.distance)) bestX = { distance: dx, reference };
        const dz = Math.abs(reference.z - point.z);
        if (dz <= threshold && (!bestZ || dz < bestZ.distance)) bestZ = { distance: dz, reference };
    }

    if (bestX) {
        result.x = bestX.reference.x;
        guides.push({ axis: 'x', reference: bestX.reference });
    }
    if (bestZ) {
        result.z = bestZ.reference.z;
        guides.push({ axis: 'z', reference: bestZ.reference });
    }

    return { point: result, guides };
}

// Renders a set of AxisGuide segments as simple THREE.Line objects (one per guide, from the
// reference point to the snapped point), reusing the same pooled-lines pattern several
// tools in this codebase already use for preview overlays.
export class AxisGuideRenderer {
    private lines: THREE.Line[] = [];

    constructor(private readonly parent: THREE.Object3D, private readonly color: number = 0xff3b30) {}

    public update(point: THREE.Vector3, guides: AxisGuide[]): void {
        this.clearExtra(guides.length);
        guides.forEach((guide, index) => {
            const line = this.lines[index] ?? this.createLine();
            line.geometry.dispose();
            line.geometry = new THREE.BufferGeometry().setFromPoints([guide.reference, point]);
            line.computeLineDistances();
            line.visible = true;
        });
    }

    public clear(): void {
        for (const line of this.lines) line.visible = false;
    }

    public dispose(): void {
        for (const line of this.lines) {
            this.parent.remove(line);
            line.geometry.dispose();
            (line.material as THREE.Material).dispose();
        }
        this.lines = [];
    }

    private createLine(): THREE.Line {
        const line = new THREE.Line(
            new THREE.BufferGeometry(),
            new THREE.LineDashedMaterial({ color: this.color, depthTest: false, dashSize: 0.3, gapSize: 0.15, transparent: true, opacity: 0.95 }),
        );
        line.renderOrder = 999;
        this.parent.add(line);
        this.lines.push(line);
        return line;
    }

    private clearExtra(keep: number): void {
        for (let index = 0; index < this.lines.length; index++) this.lines[index].visible = index < keep;
    }
}
