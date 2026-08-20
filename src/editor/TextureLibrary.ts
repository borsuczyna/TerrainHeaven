import * as THREE from 'three';
import { singleton } from 'tsyringe';

export interface TextureAsset {
    path: string;
    name: string;
    url: string;
    size: number;
}

interface StoredTexture {
    path: string;
    name: string;
    blob: Blob;
    size: number;
    updatedAt: number;
}

const DB_NAME = 'santown-assets';
const DB_VERSION = 1;
const STORE_NAME = 'textures';

@singleton()
export default class TextureLibrary {
    private readonly assets = new Map<string, TextureAsset>();
    private readonly missingPaths = new Set<string>();
    private readonly readyPromise: Promise<void>;
    public onChanged: (() => void) | null = null;
    public onAssetAvailable: ((path: string) => void) | null = null;

    constructor() {
        this.readyPromise = this.restore().catch((error) => {
            console.warn('Texture library persistence is unavailable:', error);
        });
    }

    public async ready(): Promise<void> {
        await this.readyPromise;
    }

    public getAssets(): TextureAsset[] {
        return [...this.assets.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    public getMissingPaths(): string[] {
        return [...this.missingPaths].sort();
    }

    public async addFiles(files: Iterable<File>): Promise<string[]> {
        await this.ready();
        const addedPaths: string[] = [];

        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            const uploadedPath = this.normalizePath(file.webkitRelativePath || file.name);
            const relinkPath = this.findMissingPathForFile(uploadedPath, file.name);
            const path = relinkPath ?? uploadedPath;
            await this.storeFile(path, file);
            this.missingPaths.delete(path);
            addedPaths.push(path);
            this.onAssetAvailable?.(path);
        }

        if (addedPaths.length > 0) this.onChanged?.();
        return addedPaths;
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

    public async loadTexture(path: string): Promise<THREE.Texture | null> {
        await this.ready();
        const normalized = this.normalizePath(path);
        const asset = this.assets.get(normalized);
        if (!asset) {
            this.missingPaths.add(normalized);
            this.onChanged?.();
            return null;
        }

        return await new Promise<THREE.Texture | null>((resolve) => {
            new THREE.TextureLoader().load(
                asset.url,
                (texture) => {
                    texture.wrapS = THREE.RepeatWrapping;
                    texture.wrapT = THREE.RepeatWrapping;
                    texture.colorSpace = THREE.SRGBColorSpace;
                    texture.userData.sourcePath = normalized;
                    resolve(texture);
                },
                undefined,
                () => resolve(null),
            );
        });
    }

    private async restore(): Promise<void> {
        const records = await this.readAllRecords();
        for (const record of records) {
            this.installAsset(record);
        }
        this.onChanged?.();
    }

    private async storeFile(path: string, file: File): Promise<void> {
        const record: StoredTexture = {
            path,
            name: file.name,
            blob: file,
            size: file.size,
            updatedAt: Date.now(),
        };
        try {
            await this.writeRecord(record);
        } catch (error) {
            console.warn('Texture will be available only for this session:', error);
        }
        this.installAsset(record);
    }

    private installAsset(record: StoredTexture): void {
        const previous = this.assets.get(record.path);
        if (previous) URL.revokeObjectURL(previous.url);
        this.assets.set(record.path, {
            path: record.path,
            name: record.name,
            size: record.size,
            url: URL.createObjectURL(record.blob),
        });
    }

    private findMissingPathForFile(uploadedPath: string, fileName: string): string | null {
        if (this.missingPaths.has(uploadedPath)) return uploadedPath;
        const matches = [...this.missingPaths].filter((path) => this.basename(path) === fileName);
        return matches.length === 1 ? matches[0] : null;
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
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'path' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    private async readAllRecords(): Promise<StoredTexture[]> {
        const db = await this.openDatabase();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).getAll();
            request.onsuccess = () => resolve(request.result as StoredTexture[]);
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => db.close();
        });
    }

    private async writeRecord(record: StoredTexture): Promise<void> {
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
}
