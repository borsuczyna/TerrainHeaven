import * as THREE from 'three';
import type WorldElement from '../elements/WorldElement';
import { singleton } from 'tsyringe';

@singleton()
export default class SceneManager {
    public readonly instance: THREE.Scene = new THREE.Scene();
    public onSceneGeometryChanged: (() => void) | null = null;
    private elements: WorldElement[] = [];
    private terrainDirty = false;
    private terrainDependentsDirty = false;
    private terrainSurfaceChangedDirty = false;
    private readonly terrainSurfaceChangedListeners = new Set<() => void>();
    private isUpdatingAll = false;
    constructor() {
        this.instance = new THREE.Scene();
        this.setupGrid();
        this.setupLighting();
    }

    private setupGrid(): void {
        const gridHelper = new THREE.GridHelper(100, 100, 0x888888, 0x555555);
        (gridHelper.material as THREE.Material).transparent = true;
        (gridHelper.material as THREE.Material).opacity = 0.2;
        this.instance.add(gridHelper);
    }

    private setupLighting(): void {
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.1);
        this.instance.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
        directionalLight.position.set(10, 20, 10);
        this.instance.add(directionalLight);
    }

    public add(object: WorldElement, update: boolean = true): void {
        this.elements.push(object);
        this.instance.add(object.mesh);
        object.onGeometryChanged = () => {
            if (this.isUpdatingAll) return;
            if (this.isTerrain(object)) {
                // Adjacent terrain tiles share explicit edge constraints. Rebuild the
                // neighbours on the next flush whenever one side changes its shape.
                this.terrainDirty = true;
                this.terrainDependentsDirty = true;
                this.terrainSurfaceChangedDirty = true;
            }
            else this.markTerrainDirty();
            this.onSceneGeometryChanged?.();
        };
        if (update) object.update();
    }

    public getElements(): WorldElement[] {
        return this.elements;
    }

    public clearElements(): void {
        for (const el of this.elements) {
            this.instance.remove(el.mesh);
            el.dispose();
        }
        this.elements = [];
        this.terrainDirty = false;
        this.terrainDependentsDirty = false;
        this.terrainSurfaceChangedDirty = false;
        this.notifyTerrainSurfaceChanged();
        this.onSceneGeometryChanged?.();
    }

    public remove(element: WorldElement): boolean {
        const index = this.elements.indexOf(element);
        if (index < 0) return false;

        for (const nodeIndex of [...element.connections.keys()]) {
            element.disconnect(nodeIndex);
        }
        this.elements.splice(index, 1);
        this.instance.remove(element.mesh);
        element.dispose();
        this.markTerrainDirty();
        this.onSceneGeometryChanged?.();
        return true;
    }

    public addMesh(mesh: THREE.Mesh): void {
        this.instance.add(mesh);
    }

    public update(): void {
        this.isUpdatingAll = true;
        try {
            // Terrain depends on all road/intersection geometry, so it must be last.
            for (const element of this.elements) {
                if (!this.isTerrain(element)) element.update();
            }
            for (const element of this.elements) {
                if (this.isTerrain(element)) element.update();
            }
            for (const element of this.elements) {
                if (element.dependsOnTerrainSurface()) element.update();
            }
            this.terrainDirty = false;
            this.terrainDependentsDirty = false;
            this.terrainSurfaceChangedDirty = false;
        } finally {
            this.isUpdatingAll = false;
        }
        this.notifyTerrainSurfaceChanged();
        this.onSceneGeometryChanged?.();
    }

    public onTerrainSurfaceChanged(listener: () => void): () => void {
        this.terrainSurfaceChangedListeners.add(listener);
        return () => this.terrainSurfaceChangedListeners.delete(listener);
    }

    public markTerrainDirty(): void {
        this.terrainDirty = true;
    }

    public flushDirty(): void {
        if ((!this.terrainDirty && !this.terrainDependentsDirty && !this.terrainSurfaceChangedDirty) || this.isUpdatingAll) return;
        const rebuildTerrain = this.terrainDirty;
        const rebuildDependents = this.terrainDependentsDirty || rebuildTerrain;
        const terrainSurfaceChanged = this.terrainSurfaceChangedDirty || rebuildTerrain;
        this.terrainDirty = false;
        this.terrainDependentsDirty = false;
        this.terrainSurfaceChangedDirty = false;

        this.isUpdatingAll = true;
        try {
            if (rebuildTerrain) {
                for (const element of this.elements) {
                    if (this.isTerrain(element)) element.update();
                }
            }
            if (rebuildDependents) {
                for (const element of this.elements) {
                    if (element.dependsOnTerrainSurface()) element.update();
                }
            }
        } finally {
            this.isUpdatingAll = false;
        }
        if (terrainSurfaceChanged) this.notifyTerrainSurfaceChanged();
        this.onSceneGeometryChanged?.();
    }

    private notifyTerrainSurfaceChanged(): void {
        for (const listener of this.terrainSurfaceChangedListeners) listener();
    }

    private isTerrain(element: WorldElement): boolean {
        return element.isTerrainSurface();
    }
}
