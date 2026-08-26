import { inject, singleton } from 'tsyringe';
import SceneManager from '../editor/SceneManager';
import TextureLibrary from '../editor/TextureLibrary';
import FoliageManager from '../editor/FoliageManager';
import MeshManager from '../editor/MeshManager';
import MeshLibrary from '../editor/MeshLibrary';
import ProjectSettings from '../editor/ProjectSettings';
import type WorldElement from '../elements/WorldElement';
import type { GeometryGroup } from '../elements/WorldElement';
import Terrain from '../elements/Terrain';
import Road from '../elements/Road';
import Intersection from '../elements/Intersection';
import RiverSpline from '../elements/RiverSpline';
import Fence from '../elements/Fence';
import Stairs from '../elements/Stairs';
import PolygonTerrain from '../elements/PolygonTerrain';
import Building from '../elements/Building';
import { MAX_LOD_INDEX } from './LODLevels';
import { buildMtl, buildObj, type ObjGroup, type ObjMaterial } from './ObjWriter';
import { loadMeshAsset } from '../mesh/MeshLoader';
import { getLODGroups } from '../mesh/MeshLODGenerator';
import { calibrateGroups } from '../mesh/MeshCalibration';
import type { MeshAssetData } from '../mesh/MeshData';

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

type ExportKind = 'terrain' | 'road' | 'intersection' | 'river' | 'fence' | 'stairs' | 'terrainPolygon' | 'building';

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
    terrainPaint?: {
        controlMap: string;
        resolution: number;
        layers: { texture: string | null; tiling: number }[];
    };
}

// One entry per mesh-prop asset actually placed at least once - never one per placed
// instance. Placements is the reuse list: the Unity importer builds each Asset's Mesh(es)
// once and instantiates one GameObject per Placement, all referencing that same asset.
interface ManifestMeshAsset {
    id: string;
    name: string;
    lods: ManifestLod[];
}

interface ManifestMeshPlacement {
    assetId: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: number;
}

interface Manifest {
    version: 1;
    scale: number;
    lodLevels: number;
    objects: ManifestObject[];
    foliageFile: string;
    meshesFile: string;
    // Distance (in the same pre-scale units as everything else) at which the Unity
    // importer should switch LOD0->1, LOD1->2 and LOD2->3 on every LODGroup it builds -
    // see ProjectSettings.lodDistances for why this exists.
    lodDistances: number[];
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
        @inject(MeshManager) private readonly meshManager: MeshManager,
        @inject(MeshLibrary) private readonly meshLibrary: MeshLibrary,
        @inject(ProjectSettings) private readonly projectSettings: ProjectSettings,
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
        const usedMeshAssets = this.meshManager.assets
            .map((asset, index) => ({ asset, index }))
            .filter(({ index }) => this.meshManager.getInstances(index).length > 0);
        // Texture count isn't known until the mesh pass has collected every referenced
        // path, so the mesh steps make up the bulk of the total and textures/foliage/
        // manifest are a fixed-size tail reported as it happens.
        const total = exportable.length * lodLevels + usedMeshAssets.length * (lodLevels + 1) + 4;
        let step = 0;
        const report = (message: string): void => onProgress?.({ message, current: step, total });

        const meshesDir = await root.getDirectoryHandle('Meshes', { create: true });
        const texturesDir = await root.getDirectoryHandle('Textures', { create: true });
        const controlMapsDir = await root.getDirectoryHandle('ControlMaps', { create: true });

        const objects = await this.writeObjects(meshesDir, controlMapsDir, exportable, lodLevels, scale, texturePaths, (message) => {
            report(message);
            step++;
        });

        const { assets: meshAssets, placements: meshPlacements } = await this.writeMeshAssets(
            meshesDir, texturesDir, usedMeshAssets, lodLevels, (message) => {
                report(message);
                step++;
            },
        );

        report('Writing foliage data...');
        const foliageData = this.foliage.serialize();
        for (const type of foliageData.Types) if (type.TexturePath) texturePaths.add(type.TexturePath);
        await this.writeFile(root, 'foliage.json', JSON.stringify(foliageData, null, 2));
        step++;

        report('Writing mesh prop placements...');
        await this.writeFile(root, 'meshes.json', JSON.stringify({ version: 1, assets: meshAssets, placements: meshPlacements }, null, 2));
        step++;

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
            meshesFile: 'meshes.json',
            lodDistances: [...this.projectSettings.lodDistances],
            textures: textureNames,
        };
        await this.writeFile(root, 'manifest.json', JSON.stringify(manifest, null, 2));
        step++;
        report('Done');
    }

    // Each placed-prop asset is written once (per LOD) here, regardless of how many
    // instances of it were painted/lined - Placements below is the reuse list the Unity
    // importer instantiates against that one shared Mesh, which is the whole point of
    // treating uploaded props differently from the always-unique procedural geometry
    // writeObjects() handles. Unlike terrain/road/river (which bake `scale` directly into
    // exported vertex positions because each becomes its own unparented Unity object),
    // prop geometry and Placement positions are written unscaled, same as foliage
    // instances - the importer is expected to apply `scale` once, as the shared parent
    // transform both systems already rely on to keep placement and geometry scaled together.
    private async writeMeshAssets(
        meshesDir: DirectoryHandleLike,
        texturesDir: DirectoryHandleLike,
        usedAssets: { asset: MeshAssetData; index: number }[],
        lodLevels: number,
        onStep: (message: string) => void,
    ): Promise<{ assets: ManifestMeshAsset[]; placements: ManifestMeshPlacement[] }> {
        const assets: ManifestMeshAsset[] = [];
        const placements: ManifestMeshPlacement[] = [];
        const writtenTextures = new Map<string, string | null>();

        for (const { asset, index } of usedAssets) {
            const libraryAsset = this.meshLibrary.getAsset(asset.LibraryPath);
            if (!libraryAsset) {
                console.warn(`Unity export: mesh prop "${asset.DisplayName}" is missing from the library; skipping.`);
                continue;
            }

            onStep(`Loading ${asset.DisplayName}...`);
            let loaded;
            try {
                loaded = await loadMeshAsset(libraryAsset);
            } catch (error) {
                console.warn(`Unity export: failed to load mesh prop "${asset.DisplayName}".`, error);
                continue;
            }

            const fileBase = `prop_${asset.Id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
            const lods: ManifestLod[] = [];

            for (let lod = 0; lod < lodLevels; lod++) {
                onStep(`Building ${asset.DisplayName} (LOD ${lod})...`);
                const lodGroups = calibrateGroups(getLODGroups(asset.LibraryPath, lod, loaded), asset.BaseScale, asset.PositionOffset);
                const objGroups: ObjGroup[] = [];
                const materials: ObjMaterial[] = [];
                const manifestGroups: ManifestLodGroup[] = [];

                for (let groupIndex = 0; groupIndex < lodGroups.length; groupIndex++) {
                    const group = lodGroups[groupIndex];
                    if (group.positions.length === 0) continue;
                    const materialName = `${fileBase}_g${groupIndex}`;

                    let textureFile: string | null | undefined = group.textureUrl ? writtenTextures.get(group.textureUrl) : null;
                    if (textureFile === undefined) {
                        textureFile = await this.writeMeshTexture(texturesDir, group.textureUrl!, `${fileBase}_g${groupIndex}`);
                        writtenTextures.set(group.textureUrl!, textureFile);
                    }

                    objGroups.push({ name: group.name, materialName, positions: group.positions, uvs: group.uvs });
                    materials.push({ name: materialName, textureRelativePath: textureFile ? `../Textures/${textureFile}` : null });
                    manifestGroups.push({ name: group.name, texture: textureFile });
                }

                const lodFileBase = `${fileBase}_lod${lod}`;
                await this.writeFile(meshesDir, `${lodFileBase}.obj`, buildObj(`${lodFileBase}.mtl`, lodFileBase, objGroups));
                await this.writeFile(meshesDir, `${lodFileBase}.mtl`, buildMtl(materials));
                lods.push({ objFile: `Meshes/${lodFileBase}.obj`, mtlFile: `Meshes/${lodFileBase}.mtl`, groups: manifestGroups });
            }

            assets.push({ id: asset.Id, name: asset.DisplayName, lods });
            for (const instance of this.meshManager.getInstances(index)) {
                placements.push({
                    assetId: asset.Id,
                    position: { ...instance.Position },
                    rotation: { x: instance.RotationX, y: instance.RotationY, z: instance.RotationZ },
                    scale: instance.Scale,
                });
            }
        }

        return { assets, placements };
    }

    // Mirrors src/editor/TextureLibrary asset writing below (fetch -> raw bytes to disk),
    // but the source is a THREE.Texture's own image (a blob:/data: URL from MeshLoader)
    // rather than a TextureLibrary path, so it can't reuse writeTextures() directly.
    private async writeMeshTexture(texturesDir: DirectoryHandleLike, textureUrl: string, fileNameHint: string): Promise<string | null> {
        try {
            const response = await fetch(textureUrl);
            const blob = await response.blob();
            const fileName = `${fileNameHint}.${extensionForMimeType(blob.type)}`;
            await this.writeFile(texturesDir, fileName, new Uint8Array(await blob.arrayBuffer()));
            return fileName;
        } catch (error) {
            console.warn('Unity export: failed to write a mesh prop texture.', error);
            return null;
        }
    }

    private async writeObjects(
        meshesDir: DirectoryHandleLike,
        controlMapsDir: DirectoryHandleLike,
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

            const manifestObject: ManifestObject = { type: kind, name, lods };
            if (element instanceof Terrain) {
                const paint = element.getTexturePaintExportData();
                const controlMapName = `${name}_control.png`;
                await this.writeControlMap(controlMapsDir, controlMapName, paint.resolution, paint.rgba);
                for (const layer of paint.layers) if (layer.texturePath) texturePaths.add(layer.texturePath);
                manifestObject.terrainPaint = {
                    controlMap: `ControlMaps/${controlMapName}`,
                    resolution: paint.resolution,
                    layers: paint.layers.map((layer) => ({
                        texture: layer.texturePath ? textureFileName(layer.texturePath) : null,
                        tiling: layer.tiling,
                    })),
                };
            }
            objects.push(manifestObject);
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
        if (element instanceof Stairs) return 'stairs';
        if (element instanceof PolygonTerrain) return 'terrainPolygon';
        if (element instanceof Building) return 'building';
        return null;
    }

    private getExportGeometry(element: WorldElement, kind: ExportKind, lodIndex: number): GeometryGroup[] {
        switch (kind) {
            case 'terrain': return (element as Terrain).getExportGeometry(lodIndex);
            case 'road': return (element as Road).getExportGeometry(lodIndex);
            case 'intersection': return (element as Intersection).getExportGeometry(lodIndex);
            case 'river': return (element as RiverSpline).getExportGeometry(lodIndex);
            case 'fence': return (element as Fence).getExportGeometry(lodIndex);
            case 'stairs': return (element as Stairs).getExportGeometry(lodIndex);
            case 'terrainPolygon': return (element as PolygonTerrain).getExportGeometry(lodIndex);
            case 'building': return (element as Building).getExportGeometry(lodIndex);
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

    private async writeControlMap(dir: DirectoryHandleLike, name: string, resolution: number, rgba: Uint8Array): Promise<void> {
        const canvas = document.createElement('canvas');
        canvas.width = resolution;
        canvas.height = resolution;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D is unavailable; cannot encode terrain control map.');
        // PNG rows start at the visual top while Unity control-map UVs use bottom-left.
        // Flip once during export so importers can sample the image with ordinary UVs.
        const pngRgba = new Uint8ClampedArray(rgba.length);
        for (let y = 0; y < resolution; y++) {
            const source = y * resolution * 4;
            const destination = (resolution - 1 - y) * resolution * 4;
            pngRgba.set(rgba.subarray(source, source + resolution * 4), destination);
        }
        context.putImageData(new ImageData(pngRgba, resolution, resolution), 0, 0);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
            (value) => value ? resolve(value) : reject(new Error('Failed to encode terrain control map.')),
            'image/png',
        ));
        await this.writeFile(dir, name, new Uint8Array(await blob.arrayBuffer()));
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

const MIME_EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
};

function extensionForMimeType(mimeType: string): string {
    return MIME_EXTENSIONS[mimeType] ?? 'png';
}
