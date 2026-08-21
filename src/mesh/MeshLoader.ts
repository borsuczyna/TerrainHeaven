import * as THREE from 'three';
import { container } from 'tsyringe';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import MeshLibrary, { type MeshBundleAsset } from '../editor/MeshLibrary';
import TextureLibrary from '../editor/TextureLibrary';

// A fully opaque, mid-gray 1x1 PNG. Returned by the URL modifier instead of a dead link
// whenever a referenced texture can't be found, so a missing texture always resolves to a
// *valid* GPU texture - the previous behavior (letting the fetch fail) left the real
// three.js Texture bound but never uploaded, which WebGL renders as solid black, not "no
// texture". Detected again after load by exact URL match so the group can fall back to
// its flat material color instead of showing this placeholder.
const MISSING_TEXTURE_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// One material's worth of a loaded asset: a flat, unindexed triangle soup (matches how
// the rest of this app already represents exportable geometry - see GeometryGroup in
// WorldElement and ObjGroup in src/export/ObjWriter.ts) plus enough material info to
// render a preview and, later, write a texture file on export. Normals are deliberately
// not carried here: ObjWriter recomputes auto-smooth normals from positions alone for
// every other exported object, and preview builds its own via computeVertexNormals, so
// carrying (and decimating) a separate normal stream would be pure overhead.
export interface LoadedMeshGroup {
    name: string;
    positions: number[];
    uvs: number[];
    color: { r: number; g: number; b: number };
    // The texture's own image source (a blob: URL in every supported format - OBJ/FBX
    // side textures resolve through the bundle's companion blob URLs, GLB's embedded
    // images are turned into blob URLs by GLTFLoader itself) so export can fetch() the
    // bytes without re-decoding the THREE.Texture.
    textureUrl: string | null;
    texture: THREE.Texture | null;
}

export interface LoadedMeshAsset {
    groups: LoadedMeshGroup[];
    // Filenames the mesh referenced (a .mtl's map_Kd, an FBX/GLTF side texture) that
    // weren't found either in this asset's own upload or anywhere else already in the
    // browser's texture/mesh libraries - surfaced by MeshCalibrationPanel so the user can
    // drop the missing files in before placing the prop.
    missingTextures: string[];
}

const loadedAssetCache = new Map<string, Promise<LoadedMeshAsset>>();

// Cached by bundle path: the same uploaded asset is loaded once and reused for every
// preview InstancedMesh and every LOD decimation, not re-parsed per instance.
export function loadMeshAsset(asset: MeshBundleAsset): Promise<LoadedMeshAsset> {
    const cached = loadedAssetCache.get(asset.path);
    if (cached) return cached;
    const promise = loadMeshAssetUncached(asset).catch((error) => {
        loadedAssetCache.delete(asset.path);
        throw error;
    });
    loadedAssetCache.set(asset.path, promise);
    return promise;
}

export function invalidateMeshAsset(path: string): void {
    loadedAssetCache.delete(path);
}

async function loadMeshAssetUncached(asset: MeshBundleAsset): Promise<LoadedMeshAsset> {
    const externalTextures = await buildExternalTextureLookup(asset);
    const missingTextureNames = new Set<string>();
    const manager = createManager(asset, externalTextures, missingTextureNames);
    const root = await loadRoot(asset, manager);
    root.updateWorldMatrix(true, true);

    const groups: LoadedMeshGroup[] = [];
    let meshIndex = 0;
    root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const mesh = object;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        // mesh.matrixWorld already folds in every ancestor transform up to (and including)
        // the loader's own root object - some loaders (FBXLoader in particular) bake a
        // unit-conversion scale onto that root rather than onto each mesh, so this must
        // stay the *world* matrix rather than one made relative to the root.
        const relativeMatrix = mesh.matrixWorld;
        const geometryGroups = mesh.geometry.groups.length > 0
            ? mesh.geometry.groups
            : [{ start: 0, count: indexOrPositionCount(mesh.geometry), materialIndex: 0 }];

        for (const range of geometryGroups) {
            const material = materials[range.materialIndex ?? 0] ?? materials[0];
            const { positions, uvs } = extractRange(mesh.geometry, range.start, range.count, relativeMatrix);
            if (positions.length === 0) continue;
            const rawMap = material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhongMaterial
                || material instanceof THREE.MeshBasicMaterial || material instanceof THREE.MeshLambertMaterial
                ? material.map : null;
            const color = material && 'color' in material && material.color instanceof THREE.Color
                ? material.color : new THREE.Color(0xcccccc);
            const textureUrl = extractTextureUrl(rawMap);
            // The placeholder loaded cleanly (so it wouldn't render black), but it isn't a
            // real texture - treat the group as untextured so it renders/exports the
            // material's flat color instead of a gray square.
            const isMissingPlaceholder = textureUrl === MISSING_TEXTURE_URL;
            groups.push({
                name: `${mesh.name || `mesh${meshIndex}`}_${range.materialIndex ?? 0}`,
                positions,
                uvs,
                color: { r: color.r, g: color.g, b: color.b },
                textureUrl: isMissingPlaceholder ? null : textureUrl,
                texture: isMissingPlaceholder ? null : rawMap,
            });
        }
        meshIndex++;
    });

    return { groups, missingTextures: [...missingTextureNames].sort() };
}

function indexOrPositionCount(geometry: THREE.BufferGeometry): number {
    return geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
}

function extractRange(
    geometry: THREE.BufferGeometry,
    start: number,
    count: number,
    matrix: THREE.Matrix4,
): { positions: number[]; uvs: number[] } {
    const positionAttribute = geometry.getAttribute('position');
    const uvAttribute = geometry.getAttribute('uv');
    const index = geometry.getIndex();
    const positions: number[] = [];
    const uvs: number[] = [];
    const vertex = new THREE.Vector3();

    const pushVertex = (vertexIndex: number): void => {
        vertex.fromBufferAttribute(positionAttribute, vertexIndex).applyMatrix4(matrix);
        positions.push(vertex.x, vertex.y, vertex.z);
        if (uvAttribute) uvs.push(uvAttribute.getX(vertexIndex), uvAttribute.getY(vertexIndex));
        else uvs.push(0, 0);
    };

    const end = start + count;
    if (index) {
        for (let i = start; i < end && i < index.count; i++) pushVertex(index.getX(i));
    } else {
        for (let i = start; i < end && i < positionAttribute.count; i++) pushVertex(i);
    }
    return { positions, uvs };
}

// GLB textures are commonly decoded straight to an ImageBitmap (no .src to fetch), while
// OBJ/FBX side textures load as a normal HTMLImageElement pointed at a companion blob URL.
// Either way this recovers a URL export can fetch() later without re-touching THREE.Texture.
function extractTextureUrl(texture: THREE.Texture | null): string | null {
    const image = texture?.image as { src?: string } | ImageBitmap | HTMLCanvasElement | undefined;
    if (!image) return null;
    if (typeof (image as { src?: string }).src === 'string') return (image as { src: string }).src;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) return imageBitmapToDataUrl(image);
    if (image instanceof HTMLCanvasElement) return image.toDataURL();
    return null;
}

function imageBitmapToDataUrl(bitmap: ImageBitmap): string | null {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/png');
}

// Before giving up on a texture reference, this looks for a same-named file already sitting
// in the browser's asset stores - every other mesh bundle uploaded so far, and the terrain/
// road TextureLibrary - so re-uploading the same shared texture.png for a second prop isn't
// required. Built once per asset load rather than per-file lookup.
async function buildExternalTextureLookup(asset: MeshBundleAsset): Promise<Map<string, string>> {
    const lookup = new Map<string, string>();

    const meshLibrary = container.resolve(MeshLibrary);
    for (const bundle of meshLibrary.getAssets()) {
        if (bundle.path === asset.path) continue;
        for (const [name, url] of bundle.companionUrls) if (!lookup.has(name)) lookup.set(name, url);
    }

    const textureLibrary = container.resolve(TextureLibrary);
    await textureLibrary.ready();
    for (const textureAsset of textureLibrary.getAssets()) {
        const baseName = (textureAsset.path.split('/').pop() ?? textureAsset.path).toLowerCase();
        if (!lookup.has(baseName)) lookup.set(baseName, textureAsset.url);
    }

    return lookup;
}

function createManager(
    asset: MeshBundleAsset,
    externalTextures: Map<string, string>,
    missingTextureNames: Set<string>,
): THREE.LoadingManager {
    const manager = new THREE.LoadingManager();
    // Loaders resolve relative companion paths (an .mtl's map_Kd, an FBX's relative
    // texture link) against wherever they think the main file "lives" - for a blob: URL
    // that resolution is meaningless, so this only trusts the final path segment (the
    // actual filename the loader asked for) and matches it against the bundle's own
    // companions first, then every other already-uploaded texture, by basename.
    // Loaders resolve their OWN entry-point url (the main file, and any blob url this
    // module already handed them directly, like the .mtl entry below) through this same
    // modifier - not just relative side-resource requests. Those must pass through
    // untouched, or the main file's request gets treated as "not a known companion" and
    // rewritten to the missing-texture placeholder, corrupting the actual model load.
    const passthroughUrls = new Set<string>([asset.mainUrl, ...asset.companionUrls.values()]);
    manager.setURLModifier((url) => {
        if (passthroughUrls.has(url)) return url;
        const fileName = (url.split('/').pop()?.split('?')[0] ?? '').toLowerCase();
        if (!fileName) return url;
        const own = asset.companionUrls.get(fileName);
        if (own) return own;
        const external = externalTextures.get(fileName);
        if (external) return external;
        if (/\.(png|jpe?g|webp|gif|bmp|tga|dds)$/i.test(fileName)) missingTextureNames.add(fileName);
        return MISSING_TEXTURE_URL;
    });
    return manager;
}

async function loadRoot(asset: MeshBundleAsset, manager: THREE.LoadingManager): Promise<THREE.Object3D> {
    if (asset.format === 'obj') {
        const mtlEntry = [...asset.companionUrls.entries()].find(([name]) => name.endsWith('.mtl'));
        const objLoader = new OBJLoader(manager);
        if (mtlEntry) {
            const materialCreator = await new Promise<MTLLoader.MaterialCreator>((resolve, reject) => {
                new MTLLoader(manager).load(mtlEntry[1], resolve, undefined, reject);
            });
            materialCreator.preload();
            objLoader.setMaterials(materialCreator);
        }
        return await new Promise<THREE.Group>((resolve, reject) => objLoader.load(asset.mainUrl, resolve, undefined, reject));
    }

    if (asset.format === 'fbx') {
        return await new Promise<THREE.Group>((resolve, reject) => (
            new FBXLoader(manager).load(asset.mainUrl, resolve, undefined, reject)
        ));
    }

    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => (
        new GLTFLoader(manager).load(asset.mainUrl, resolve, undefined, reject)
    ));
    return gltf.scene;
}
