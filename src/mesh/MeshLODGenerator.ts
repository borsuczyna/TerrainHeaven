import * as THREE from 'three';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { MAX_LOD_INDEX } from '../export/LODLevels';
import type { LoadedMeshAsset, LoadedMeshGroup } from './MeshLoader';

// Fraction of the original vertex count kept at each LOD index, mirroring the fixed,
// progressively-coarser presets every other exported object already uses (see
// TRIANGLE_LIMIT_MULTIPLIER in src/export/LODLevels.ts). Uploaded props are arbitrary
// triangle soups with no procedural regeneration path, so - per the user's request -
// coarser LODs come from decimating LOD0 with SimplifyModifier instead.
const KEEP_RATIO = [1, 0.4, 0.15, 0.05];

// Below this many vertices decimation either fails outright (SimplifyModifier needs a
// handful of vertices to collapse edges into) or simply isn't worth the CPU time.
const MIN_VERTICES_TO_SIMPLIFY = 24;

const cache = new Map<string, LoadedMeshGroup[]>();

export function getLODGroups(assetPath: string, lodIndex: number, base: LoadedMeshAsset): LoadedMeshGroup[] {
    const clampedIndex = Math.max(0, Math.min(MAX_LOD_INDEX, Math.round(lodIndex)));
    if (clampedIndex === 0) return base.groups;

    const key = `${assetPath}::${clampedIndex}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const groups = base.groups.map((group) => simplifyGroup(group, KEEP_RATIO[clampedIndex]));
    cache.set(key, groups);
    return groups;
}

export function invalidateAssetLODs(assetPath: string): void {
    for (let index = 1; index <= MAX_LOD_INDEX; index++) cache.delete(`${assetPath}::${index}`);
}

function simplifyGroup(group: LoadedMeshGroup, keepRatio: number): LoadedMeshGroup {
    const vertexCount = group.positions.length / 3;
    if (vertexCount < MIN_VERTICES_TO_SIMPLIFY) return group;

    const targetVertexCount = Math.max(12, Math.round(vertexCount * keepRatio));
    const verticesToRemove = vertexCount - targetVertexCount;
    if (verticesToRemove <= 0) return group;

    try {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(group.uvs, 2));

        const simplified = new SimplifyModifier().modify(geometry, verticesToRemove);
        const positions = Array.from(simplified.getAttribute('position').array);
        const uvAttribute = simplified.getAttribute('uv');
        const uvs = uvAttribute ? Array.from(uvAttribute.array) : positions.map(() => 0).slice(0, positions.length / 3 * 2);

        geometry.dispose();
        simplified.dispose();
        return { ...group, positions, uvs };
    } catch (error) {
        console.warn(`Mesh LOD simplification failed for "${group.name}", falling back to LOD0 geometry.`, error);
        return group;
    }
}
