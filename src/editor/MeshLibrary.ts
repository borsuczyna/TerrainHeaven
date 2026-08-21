import { singleton } from 'tsyringe';
import type { MeshSourceFormat } from '../mesh/MeshData';

const MAIN_EXTENSIONS: Record<string, MeshSourceFormat> = {
    obj: 'obj',
    fbx: 'fbx',
    glb: 'glb',
    gltf: 'glb',
};

// One uploaded mesh, addressed the same way TextureLibrary addresses a texture: by a
// stable, human-meaningful path (the main file's relative path) rather than a random id,
// so re-dropping the same file after a browser/session change relinks it exactly like
// TextureLibrary's missing-texture flow does.
export interface MeshBundleAsset {
    path: string;
    displayName: string;
    format: MeshSourceFormat;
    mainFileName: string;
    mainUrl: string;
    // Keyed by basename (case-insensitive) - matches how MeshLoader's URL modifier
    // recovers the filename a loader asked for regardless of what bogus "directory" it
    // resolved that request against (see src/mesh/MeshLoader.ts).
    companionUrls: Map<string, string>;
    size: number;
}

interface StoredMeshFile {
    key: string;
    bundlePath: string;
    fileName: string;
    isMain: boolean;
    format: MeshSourceFormat | null;
    displayName: string;
    blob: Blob;
    size: number;
    updatedAt: number;
}

const DB_NAME = 'santown-assets';
const DB_VERSION = 2;
const STORE_NAME = 'meshFiles';
const TEXTURE_STORE_NAME = 'textures';

@singleton()
export default class MeshLibrary {
    private readonly assets = new Map<string, MeshBundleAsset>();
    private readonly missingPaths = new Set<string>();
    private readonly readyPromise: Promise<void>;
    public onChanged: (() => void) | null = null;
    public onAssetAvailable: ((path: string) => void) | null = null;

    constructor() {
        this.readyPromise = this.restore().catch((error) => {
            console.warn('Mesh library persistence is unavailable:', error);
        });
    }

    public async ready(): Promise<void> {
        await this.readyPromise;
    }

    public getAssets(): MeshBundleAsset[] {
        return [...this.assets.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    public getAsset(path: string): MeshBundleAsset | null {
        return this.assets.get(this.normalizePath(path)) ?? null;
    }

    public getMissingPaths(): string[] {
        return [...this.missingPaths].sort();
    }

    // One call = one asset bundle: a main mesh file plus whatever companions (mtl,
    // textures) were selected/dropped alongside it. Multiple main-format files in one
    // batch are treated as separate bundles, with non-main files attached to whichever
    // main file shares its base name (falling back to "the only main file" when there's
    // just one).
    public async addFiles(files: Iterable<File>): Promise<string[]> {
        await this.ready();
        const all = [...files];
        const mains = all.filter((file) => this.detectFormat(file.name) !== null);
        if (mains.length === 0) return [];
        const others = all.filter((file) => this.detectFormat(file.name) === null);

        const addedPaths: string[] = [];
        for (const mainFile of mains) {
            const format = this.detectFormat(mainFile.name)!;
            const bundlePath = this.normalizePath(mainFile.webkitRelativePath || mainFile.name);
            const baseName = this.stripExtension(mainFile.name).toLowerCase();
            const companions = others.filter((file) => (
                mains.length === 1 || this.stripExtension(file.name).toLowerCase() === baseName
            ));

            const relink = this.findMissingPathForFile(bundlePath, mainFile.name);
            const path = relink ?? bundlePath;
            await this.storeBundle(path, format, mainFile, companions);
            this.missingPaths.delete(path);
            addedPaths.push(path);
            this.onAssetAvailable?.(path);
        }

        if (addedPaths.length > 0) this.onChanged?.();
        return addedPaths;
    }

    // Attaches additional companion files (textures the loader couldn't find on first
    // load) to an already-uploaded bundle, without touching its main file - used by
    // MeshCalibrationPanel's missing-textures step. Any existing companion with the same
    // filename is replaced.
    public async addCompanionFiles(bundlePath: string, files: Iterable<File>): Promise<void> {
        await this.ready();
        const asset = this.assets.get(bundlePath);
        if (!asset) return;

        for (const file of files) {
            const record: StoredMeshFile = {
                key: `${bundlePath}::${file.name}`,
                bundlePath,
                fileName: file.name,
                isMain: false,
                format: null,
                displayName: asset.displayName,
                blob: file,
                size: file.size,
                updatedAt: Date.now(),
            };
            try {
                await this.writeRecord(record);
            } catch (error) {
                console.warn('Mesh companion texture will be available only for this session:', error);
            }
            const lowerName = file.name.toLowerCase();
            const previousUrl = asset.companionUrls.get(lowerName);
            if (previousUrl) URL.revokeObjectURL(previousUrl);
            asset.companionUrls.set(lowerName, URL.createObjectURL(file));
        }
        this.onChanged?.();
    }

    public async renameAsset(path: string, displayName: string): Promise<void> {
        const asset = this.assets.get(path);
        if (!asset) return;
        asset.displayName = displayName;
        this.onChanged?.();
    }

    public async removeAsset(path: string): Promise<void> {
        await this.ready();
        const asset = this.assets.get(path);
        if (!asset) return;
        URL.revokeObjectURL(asset.mainUrl);
        for (const url of asset.companionUrls.values()) URL.revokeObjectURL(url);
        this.assets.delete(path);
        await this.deleteBundleRecords(path);
        this.onChanged?.();
    }

    public async setProjectReferences(paths: Iterable<string>): Promise<void> {
        await this.ready();
        this.missingPaths.clear();
        for (const rawPath of paths) {
            const path = this.normalizePath(rawPath);
            if (path && !this.assets.has(path)) this.missingPaths.add(path);
        }
        this.onChanged?.();
    }

    private async restore(): Promise<void> {
        const records = await this.readAllRecords();
        const byBundle = new Map<string, StoredMeshFile[]>();
        for (const record of records) {
            const bucket = byBundle.get(record.bundlePath);
            if (bucket) bucket.push(record);
            else byBundle.set(record.bundlePath, [record]);
        }
        for (const [bundlePath, bundleRecords] of byBundle) this.installBundle(bundlePath, bundleRecords);
        this.onChanged?.();
    }

    private async storeBundle(path: string, format: MeshSourceFormat, mainFile: File, companions: File[]): Promise<void> {
        const displayName = this.stripExtension(mainFile.name);
        const records: StoredMeshFile[] = [
            {
                key: `${path}::${mainFile.name}`,
                bundlePath: path,
                fileName: mainFile.name,
                isMain: true,
                format,
                displayName,
                blob: mainFile,
                size: mainFile.size,
                updatedAt: Date.now(),
            },
            ...companions.map((file) => ({
                key: `${path}::${file.name}`,
                bundlePath: path,
                fileName: file.name,
                isMain: false,
                format: null,
                displayName,
                blob: file,
                size: file.size,
                updatedAt: Date.now(),
            })),
        ];
        try {
            await this.deleteBundleRecords(path);
            for (const record of records) await this.writeRecord(record);
        } catch (error) {
            console.warn('Mesh asset will be available only for this session:', error);
        }
        this.installBundle(path, records);
    }

    private installBundle(bundlePath: string, records: StoredMeshFile[]): void {
        const mainRecord = records.find((record) => record.isMain);
        if (!mainRecord || !mainRecord.format) return;

        const previous = this.assets.get(bundlePath);
        if (previous) {
            URL.revokeObjectURL(previous.mainUrl);
            for (const url of previous.companionUrls.values()) URL.revokeObjectURL(url);
        }

        const companionUrls = new Map<string, string>();
        let size = mainRecord.size;
        for (const record of records) {
            if (record.isMain) continue;
            companionUrls.set(record.fileName.toLowerCase(), URL.createObjectURL(record.blob));
            size += record.size;
        }

        this.assets.set(bundlePath, {
            path: bundlePath,
            displayName: mainRecord.displayName,
            format: mainRecord.format,
            mainFileName: mainRecord.fileName,
            mainUrl: URL.createObjectURL(mainRecord.blob),
            companionUrls,
            size,
        });
    }

    private findMissingPathForFile(uploadedPath: string, fileName: string): string | null {
        if (this.missingPaths.has(uploadedPath)) return uploadedPath;
        const matches = [...this.missingPaths].filter((path) => this.basename(path) === fileName);
        return matches.length === 1 ? matches[0] : null;
    }

    private detectFormat(fileName: string): MeshSourceFormat | null {
        const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
        return MAIN_EXTENSIONS[extension] ?? null;
    }

    private stripExtension(fileName: string): string {
        const index = fileName.lastIndexOf('.');
        return index > 0 ? fileName.slice(0, index) : fileName;
    }

    private normalizePath(path: string): string {
        return path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    }

    private basename(path: string): string {
        return path.split('/').pop() ?? path;
    }

    private openDatabase(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(TEXTURE_STORE_NAME)) {
                    db.createObjectStore(TEXTURE_STORE_NAME, { keyPath: 'path' });
                }
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    private async readAllRecords(): Promise<StoredMeshFile[]> {
        const db = await this.openDatabase();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).getAll();
            request.onsuccess = () => resolve(request.result as StoredMeshFile[]);
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => db.close();
        });
    }

    private async writeRecord(record: StoredMeshFile): Promise<void> {
        const db = await this.openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        db.close();
    }

    private async deleteBundleRecords(bundlePath: string): Promise<void> {
        const db = await this.openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => {
                for (const record of request.result as StoredMeshFile[]) {
                    if (record.bundlePath === bundlePath) store.delete(record.key);
                }
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        db.close();
    }
}
