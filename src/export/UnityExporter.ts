import { inject, singleton } from 'tsyringe';
import SceneManager from '../editor/SceneManager';
import TextureLibrary from '../editor/TextureLibrary';
import FoliageManager from '../editor/FoliageManager';
import type WorldElement from '../elements/WorldElement';
import type { GeometryGroup } from '../elements/WorldElement';
import Terrain from '../elements/Terrain';
import Road from '../elements/Road';
import Intersection from '../elements/Intersection';
import RiverSpline from '../elements/RiverSpline';
import Fence from '../elements/Fence';
import { MAX_LOD_INDEX } from './LODLevels';
import { buildMtl, buildObj, type ObjGroup, type ObjMaterial } from './ObjWriter';

export interface ExportProgress {
    message: string;
    current: number;
    total: number;
}
export type ExportProgressCallback = (progress: ExportProgress) => void;

export interface UnityExportOptions {
    // How many LOD levels to bake into the file, starting from LOD 0 (as authored).
    lodLevels: number;
    // Baked directly into every exported mesh vertex (terrain/road/river). Foliage
    // instance positions are exported unscaled and left as-is - the importer applies this
    // same factor as the FoliageManager GameObject's own transform scale instead, which
    // scales both placement AND each plant's rendered size together, matching how the
    // shared FoliageType presets are never touched per-import.
    scale: number;
}

type ExportKind = 'terrain' | 'road' | 'intersection' | 'river' | 'fence';

interface ManifestLodGroup {
    // Matches one OBJ "g"/"usemtl" submesh, in file order, so the importer can assign
    // the right Texture2D-backed Material to the right submesh index without having to
    // parse the .mtl file itself (Unity's own OBJ import already builds its own
    // placeholder materials from the .mtl - the importer discards those and uses this
    // instead, so it isn't relying on Unity's mtl texture-path resolution at all).
    name: string;
    texture: string | null;
}

interface ManifestLod {
    objFile: string;
    mtlFile: string;
    groups: ManifestLodGroup[];
}

interface ManifestObject {
    type: ExportKind;
    name: string;
    lods: ManifestLod[];
}

interface Manifest {
    version: 1;
    scale: number;
    lodLevels: number;
    objects: ManifestObject[];
    foliageFile: string;
    // Filenames under Textures/, so the Unity importer can check for an already-
    // imported texture with the same name before writing the bundled bytes.
    textures: string[];
}

interface DirectoryHandleLike {
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

interface FileHandleLike {
    createWritable(): Promise<{ write(data: string | Uint8Array): Promise<void>; close(): Promise<void> }>;
}

// Writes a real Wavefront OBJ + MTL pair per object/LOD, plus real texture files, into a
// folder the user picks - rather than one JSON blob with embedded mesh data. This lets
// the Unity importer lean on Unity's own built-in OBJ importer to build each Mesh
// (including the right-handed-to-left-handed conversion Unity's importer already
// performs for any OBJ, same as one authored in Blender), instead of hand-constructing
// vertex buffers in C#.
@singleton()
export default class UnityExporter {
    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(TextureLibrary) private readonly textureLibrary: TextureLibrary,
        @inject(FoliageManager) private readonly foliage: FoliageManager,
    ) {}

    public async export(options: UnityExportOptions, onProgress?: ExportProgressCallback): Promise<void> {
        const picker = (window as any).showDirectoryPicker as undefined | (() => Promise<DirectoryHandleLike>);
        if (!picker) {
            throw new Error('This browser cannot pick an export folder (no showDirectoryPicker). Use Chrome or Edge.');
        }

        let root: DirectoryHandleLike;
        try {
            root = await picker();
        } catch {
            return; // User cancelled the folder picker.
        }

        const lodLevels = Math.max(1, Math.min(MAX_LOD_INDEX + 1, Math.round(options.lodLevels)));
        const scale = options.scale > 0 ? options.scale : 1;
        const texturePaths = new Set<string>();

        const exportable = this.scene.getElements()
            .map((element) => ({ element, kind: this.getExportKind(element) }))
            .filter((entry): entry is { element: WorldElement; kind: ExportKind } => entry.kind !== null);
        // Texture count isn't known until the mesh pass has collected every referenced
        // path, so the mesh steps make up the bulk of the total and textures/foliage/
        // manifest are a fixed-size tail reported as it happens.
        const total = exportable.length * lodLevels + 3;
        let step = 0;
        const report = (message: string): void => onProgress?.({ message, current: step, total });

        const meshesDir = await root.getDirectoryHandle('Meshes', { create: true });
        const objects = await this.writeObjects(meshesDir, exportable, lodLevels, scale, texturePaths, (message) => {
            report(message);
            step++;
        });

        report('Writing foliage data...');
        const foliageData = this.foliage.serialize();
        for (const type of foliageData.Types) if (type.TexturePath) texturePaths.add(type.TexturePath);
        await this.writeFile(root, 'foliage.json', JSON.stringify(foliageData, null, 2));
        step++;

        const texturesDir = await root.getDirectoryHandle('Textures', { create: true });
        const textureNames = await this.writeTextures(texturesDir, texturePaths, (current, textureTotal) => (
            report(`Writing textures (${current}/${textureTotal})...`)
        ));
        step++;

        report('Writing manifest...');
        const manifest: Manifest = {
            version: 1,
            scale,
            lodLevels,
            objects,
            foliageFile: 'foliage.json',
            textures: textureNames,
        };
        await this.writeFile(root, 'manifest.json', JSON.stringify(manifest, null, 2));
        step++;
        report('Done');
    }

    private async writeObjects(
        meshesDir: DirectoryHandleLike,
        exportable: { element: WorldElement; kind: ExportKind }[],
        lodLevels: number,
        scale: number,
        texturePaths: Set<string>,
        onStep: (message: string) => void,
    ): Promise<ManifestObject[]> {
        const objects: ManifestObject[] = [];
        const countByKind = new Map<ExportKind, number>();

        for (const { element, kind } of exportable) {
            const index = countByKind.get(kind) ?? 0;
            countByKind.set(kind, index + 1);
            const name = `${kind}_${index}`;

            const lods: ManifestLod[] = [];
            for (let lod = 0; lod < lodLevels; lod++) {
                onStep(`Building ${name} (LOD ${lod})...`);
                const groups = this.getExportGeometry(element, kind, lod);
                const objGroups: ObjGroup[] = [];
                const materials: ObjMaterial[] = [];
                const manifestGroups: ManifestLodGroup[] = [];
                for (const group of groups) {
                    if (group.triangles.length === 0) continue;
                    const texturePath = element.getGroupTextureReferences().get(group.name) ?? null;
                    if (texturePath) texturePaths.add(texturePath);
                    const materialName = `${name}_${group.name}`;
                    objGroups.push(this.flattenGroup(group, materialName, scale));
                    materials.push({
                        name: materialName,
                        textureRelativePath: texturePath ? `../Textures/${textureFileName(texturePath)}` : null,
                    });
                    manifestGroups.push({
                        name: group.name,
                        texture: texturePath ? textureFileName(texturePath) : null,
                    });
                }

                const fileBase = `${name}_lod${lod}`;
                const objFile = `Meshes/${fileBase}.obj`;
                const mtlFile = `Meshes/${fileBase}.mtl`;
                await this.writeFile(meshesDir, `${fileBase}.obj`, buildObj(`${fileBase}.mtl`, fileBase, objGroups));
                await this.writeFile(meshesDir, `${fileBase}.mtl`, buildMtl(materials));
                lods.push({ objFile, mtlFile, groups: manifestGroups });
            }

            objects.push({ type: kind, name, lods });
        }

        return objects;
    }

    // TerrainCutSpline (and managed cut points, which are not WorldElements at all) are
    // shaping-only inputs already baked into the terrain surface - they have no visible
    // geometry of their own and are intentionally not exported as objects.
    private getExportKind(element: WorldElement): ExportKind | null {
        if (element instanceof Terrain) return 'terrain';
        if (element instanceof RiverSpline) return 'river';
        if (element instanceof Intersection) return 'intersection';
        if (element instanceof Road) return 'road';
        if (element instanceof Fence) return 'fence';
        return null;
    }

    private getExportGeometry(element: WorldElement, kind: ExportKind, lodIndex: number): GeometryGroup[] {
        switch (kind) {
            case 'terrain': return (element as Terrain).getExportGeometry(lodIndex);
            case 'road': return (element as Road).getExportGeometry(lodIndex);
            case 'intersection': return (element as Intersection).getExportGeometry(lodIndex);
            case 'river': return (element as RiverSpline).getExportGeometry(lodIndex);
            case 'fence': return (element as Fence).getExportGeometry(lodIndex);
            default: return [];
        }
    }

    private flattenGroup(group: GeometryGroup, materialName: string, scale: number): ObjGroup {
        const positions: number[] = [];
        const uvs: number[] = [];
        for (const tri of group.triangles) {
            const flat = tri.toArray();
            for (let i = 0; i < flat.length; i++) positions.push(flat[i] * scale);
            uvs.push(...tri.uvToArray());
        }
        return { name: group.name, materialName, positions, uvs };
    }

    private async writeTextures(
        texturesDir: DirectoryHandleLike,
        paths: Set<string>,
        onStep: (current: number, total: number) => void,
    ): Promise<string[]> {
        await this.textureLibrary.ready();
        const assets = new Map(this.textureLibrary.getAssets().map((asset) => [asset.path, asset]));
        const names: string[] = [];
        const total = paths.size;
        let current = 0;
        for (const path of paths) {
            current++;
            onStep(current, total);
            const asset = assets.get(path);
            if (!asset) {
                console.warn(`Unity export: texture "${path}" was not found in the library; skipping.`);
                continue;
            }
            try {
                const buffer = new Uint8Array(await (await fetch(asset.url)).arrayBuffer());
                const fileName = textureFileName(path);
                await this.writeFile(texturesDir, fileName, buffer);
                names.push(fileName);
            } catch (error) {
                console.warn(`Unity export: failed to read texture "${path}".`, error);
            }
        }
        return names;
    }

    private async writeFile(dir: DirectoryHandleLike, name: string, data: string | Uint8Array): Promise<void> {
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
    }
}

function textureFileName(path: string): string {
    const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
    return base || 'texture.png';
}
