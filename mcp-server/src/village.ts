import { ProjectDocument } from './project.js';
import type { Vec3 } from './types.js';

export type VillageOptions = {
    center?: Vec3;
    houseCount?: number;
    spacing?: number;
    seed?: number;
    addTerrain?: boolean;
    addFences?: boolean;
    addVegetation?: boolean;
};

export function createPolishVillage(document: ProjectDocument, options: VillageOptions): Record<string, unknown> {
    const summary = document.summary();
    const center = options.center ?? suggestOpenCenter(summary.bounds);
    const houseCount = Math.max(2, Math.min(40, Math.round(options.houseCount ?? 8)));
    const spacing = Math.max(14, options.spacing ?? 22);
    const seed = Math.round(options.seed ?? 2005);
    const random = seededRandom(seed);
    const villageLength = Math.max(60, (Math.ceil(houseCount / 2) + 1) * spacing);
    const created: Record<string, number[]> = { terrain: [], roads: [], houses: [], fences: [] };

    if (options.addTerrain !== false) {
        created.terrain.push(document.addTerrain(center, villageLength + 50, 90, {
            meshDetail: 2, triangleLimit: 2600, smoothingEnabled: true, maxSlope: 28,
        }));
    }

    const roadStart = { x: center.x - villageLength / 2, y: center.y + 0.02, z: center.z };
    const roadEnd = { x: center.x + villageLength / 2, y: center.y + 0.02, z: center.z };
    created.roads.push(...document.addRoadPath([roadStart, roadEnd], { width: 4.2, lanes: 2, sidewalk: false }));

    const rows = Math.ceil(houseCount / 2);
    for (let index = 0; index < houseCount; index++) {
        const row = Math.floor(index / 2);
        const side = index % 2 === 0 ? -1 : 1;
        const width = 7 + random() * 3;
        const depth = 5.5 + random() * 2.5;
        const x = center.x + (row - (rows - 1) / 2) * spacing + (random() - 0.5) * 3;
        const z = center.z + side * (14 + random() * 3);
        const houseCenter = avoidBuildings(document, { x, y: center.y, z }, 8, spacing * 0.45);
        const roofTypes = ['gable', 'hip', 'gable', 'gambrel'] as const;
        const houseId = document.addHouse({
            center: houseCenter, width, depth, wallHeight: 2.6 + random() * 0.5,
            roofType: roofTypes[Math.floor(random() * roofTypes.length)], roofRidgeHeight: 1.3 + random() * 0.8,
            windowsPerSide: random() > 0.25 ? 2 : 1, doorSide: side < 0 ? 'north' : 'south', wing: random() > 0.72,
        });
        created.houses.push(houseId);

        if (options.addFences !== false) {
            const halfW = 6.8;
            const halfD = 6.2;
            const frontZ = houseCenter.z - side * halfD;
            const backZ = houseCenter.z + side * halfD;
            const leftX = houseCenter.x - halfW;
            const rightX = houseCenter.x + halfW;
            const gateHalf = 1.4;
            const fenceOptions = { style: 'plane', height: 1.2, postSpacing: 2.1, postHeight: 1.35 };
            created.fences.push(...document.addFencePath([
                { x: leftX, y: center.y, z: frontZ }, { x: leftX, y: center.y, z: backZ },
                { x: rightX, y: center.y, z: backZ }, { x: rightX, y: center.y, z: frontZ },
            ], fenceOptions));
            created.fences.push(...document.addFencePath([
                { x: leftX, y: center.y, z: frontZ }, { x: houseCenter.x - gateHalf, y: center.y, z: frontZ },
            ], fenceOptions));
            created.fences.push(...document.addFencePath([
                { x: houseCenter.x + gateHalf, y: center.y, z: frontZ }, { x: rightX, y: center.y, z: frontZ },
            ], fenceOptions));
        }
    }

    let foliage: Record<string, unknown> | null = null;
    if (options.addVegetation !== false) {
        foliage = document.addFoliagePatch(center, villageLength * 0.48, houseCount * 9, {
            displayName: 'Village vegetation', seed: seed + 101,
        });
    }

    return { center, houseCount, created, foliage, note: 'Village layout was generated around existing scene bounds and kept as editable native TerrainHeaven elements.' };
}

function suggestOpenCenter(bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null): Vec3 {
    if (!bounds) return { x: 0, y: 0, z: 0 };
    return { x: bounds.maxX + 75, y: 0, z: (bounds.minZ + bounds.maxZ) / 2 };
}

function avoidBuildings(document: ProjectDocument, candidate: Vec3, radius: number, step: number): Vec3 {
    const occupied = document.query('building');
    let current = { ...candidate };
    for (let attempt = 0; attempt < 8; attempt++) {
        const collision = occupied.some((building) => building.nodes.some((node) => Math.hypot(node.x - current.x, node.z - current.z) < radius));
        if (!collision) return current;
        current = { ...current, x: current.x + step };
    }
    return current;
}

function seededRandom(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
        state = Math.imul(1664525, state) + 1013904223 >>> 0;
        return state / 4294967296;
    };
}
