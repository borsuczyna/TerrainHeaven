import type { MeshVector3 } from './MeshData';
import type { LoadedMeshGroup } from './MeshLoader';

export interface MeshBounds {
    min: MeshVector3;
    max: MeshVector3;
    width: number;
    height: number;
    depth: number;
}

// Applied once, wherever a raw loaded/decimated asset turns into something rendered or
// exported: uploaded files routinely arrive in the wrong unit (a 1.8m character modeled
// in centimeters shows up 100x too large) or pivoted somewhere other than their base, and
// there is no metadata in an OBJ/FBX/GLB this app can trust to auto-correct that - so the
// user calibrates it once per asset (see MeshCalibrationPanel) and every consumer bakes
// the same BaseScale + PositionOffset into vertex positions the same way.
export function calibrateGroups(groups: LoadedMeshGroup[], baseScale: number, offset: MeshVector3): LoadedMeshGroup[] {
    const scale = baseScale > 0 ? baseScale : 1;
    return groups.map((group) => {
        const positions = new Array<number>(group.positions.length);
        for (let i = 0; i < group.positions.length; i += 3) {
            positions[i] = group.positions[i] * scale + offset.x;
            positions[i + 1] = group.positions[i + 1] * scale + offset.y;
            positions[i + 2] = group.positions[i + 2] * scale + offset.z;
        }
        return { ...group, positions };
    });
}

// Measured on the raw (uncalibrated) groups - offset never changes size, and multiplying
// by BaseScale afterwards is cheaper than re-scanning calibrated positions on every slider tick.
export function measureBounds(groups: LoadedMeshGroup[]): MeshBounds {
    let minX = Infinity; let maxX = -Infinity;
    let minY = Infinity; let maxY = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    for (const group of groups) {
        for (let i = 0; i < group.positions.length; i += 3) {
            const x = group.positions[i];
            const y = group.positions[i + 1];
            const z = group.positions[i + 2];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
    }
    if (!Number.isFinite(minX)) {
        return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, width: 0, height: 0, depth: 0 };
    }
    return {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        width: maxX - minX,
        height: maxY - minY,
        depth: maxZ - minZ,
    };
}

// "Center Mesh": picks the PositionOffset that centers the raw bounds on X/Z and rests
// its lowest point on Y=0 at the given scale - the layout a freshly-uploaded prop should
// have before it's ever placed in the world (placement itself only adds a further world
// position on top of this local calibration).
export function computeGroundedCenterOffset(bounds: MeshBounds, baseScale: number): MeshVector3 {
    const scale = baseScale > 0 ? baseScale : 1;
    return {
        x: -((bounds.min.x + bounds.max.x) / 2) * scale,
        y: -bounds.min.y * scale,
        z: -((bounds.min.z + bounds.max.z) / 2) * scale,
    };
}
