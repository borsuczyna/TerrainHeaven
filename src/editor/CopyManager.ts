import * as THREE from 'three';
import { singleton } from 'tsyringe';
import Road from '../elements/Road';
import Intersection from '../elements/Intersection';
import type WorldElement from '../elements/WorldElement';
import type SceneManager from './SceneManager';
import type { PropertyDefinition } from './Properties';

export type CopyMode = 'element' | 'properties';

@singleton()
export default class CopyManager {
    private mode: CopyMode | null = null;
    private sourceType: string | null = null;
    private propsSnapshot: Map<string, any> | null = null;
    private texturesSnapshot: Map<string, THREE.Texture> | null = null;

    // Road-specific
    private roadLength: number | null = null;
    private roadDirection: THREE.Vector3 | null = null;

    // Intersection-specific
    private intersectionNodeCount: number | null = null;

    /** Copy the full element (Ctrl+C). On paste, spawns a new instance in front of the camera. */
    public copyElement(element: WorldElement): void {
        this.mode = 'element';
        this.sourceType = element.constructor.name;
        this.snapshotProperties(element);
        this.snapshotTextures(element);

        if (element instanceof Road) {
            const a = element.nodeA.mesh.position;
            const b = element.nodeB.mesh.position;
            this.roadLength = a.distanceTo(b);
            this.roadDirection = new THREE.Vector3().subVectors(b, a).normalize();
            this.intersectionNodeCount = null;
        } else if (element instanceof Intersection) {
            this.intersectionNodeCount = element.nodeCount;
            this.roadLength = null;
            this.roadDirection = null;
        }
    }

    /** Copy only properties (from the three-dots menu). On Ctrl+V applies to the currently selected element of the same type. */
    public copyProperties(element: WorldElement): void {
        this.mode = 'properties';
        this.sourceType = element.constructor.name;
        this.snapshotProperties(element);
        this.snapshotTextures(element);
        this.roadLength = null;
        this.roadDirection = null;
        this.intersectionNodeCount = null;
    }

    public get hasCopy(): boolean {
        return this.mode !== null;
    }

    public get copyMode(): CopyMode | null {
        return this.mode;
    }

    public get copiedType(): string | null {
        return this.sourceType;
    }

    /** Whether Ctrl+V should apply properties onto the given element (properties-copy mode, same type). */
    public canPastePropertiesOnto(element: WorldElement): boolean {
        return this.mode === 'properties' && this.sourceType === element.constructor.name;
    }

    /** Whether Ctrl+V can spawn a new element (element-copy mode). */
    public canPasteElement(): boolean {
        return this.mode === 'element' && this.sourceType !== null;
    }

    /** Apply the stored property + texture snapshot onto an existing element. */
    public pastePropertiesOnto(element: WorldElement): void {
        const def = element.getProperties();
        this.applySnapshot(element, def);
    }

    /** Spawn a new element in front of the camera and apply the snapshot. Returns the new element or null. */
    public pasteElement(camera: THREE.PerspectiveCamera, scene: SceneManager): WorldElement | null {
        if (this.mode === null || this.sourceType === null) return null;

        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
        forward.normalize();

        const spawnCenter = camera.position.clone().add(forward.multiplyScalar(8));
        spawnCenter.y = 0;

        let newEl: WorldElement | null = null;

        if (this.sourceType === 'Road' && this.roadDirection !== null && this.roadLength !== null) {
            const dir = this.roadDirection.clone();
            dir.y = 0;
            if (dir.lengthSq() < 0.001) dir.set(1, 0, 0);
            dir.normalize();
            const half = this.roadLength / 2;
            const posA = spawnCenter.clone().sub(dir.clone().multiplyScalar(half));
            const posB = spawnCenter.clone().add(dir.clone().multiplyScalar(half));
            newEl = new Road(posA, posB);
        } else if (this.sourceType === 'Intersection' && this.intersectionNodeCount !== null) {
            newEl = new Intersection(spawnCenter, this.intersectionNodeCount);
        }

        if (!newEl) return null;

        scene.add(newEl);

        const def = newEl.getProperties();
        this.applySnapshot(newEl, def);

        return newEl;
    }

    private snapshotProperties(element: WorldElement, def?: PropertyDefinition): void {
        const d = def ?? element.getProperties();
        this.propsSnapshot = new Map();
        for (const section of d.sections) {
            for (const prop of section.properties) {
                if (prop.type === 'button' || prop.type === 'vector3') continue;
                const id = `${section.label}-${prop.label}`.replace(/\s+/g, '-').toLowerCase();
                this.propsSnapshot.set(id, prop.get());
            }
        }
    }

    private snapshotTextures(element: WorldElement): void {
        this.texturesSnapshot = new Map();
        for (const groupName of element.getGroupNames()) {
            const tex = element.getGroupTexture(groupName);
            if (tex) this.texturesSnapshot.set(groupName, tex);
        }
    }

    private applySnapshot(element: WorldElement, def: PropertyDefinition): void {
        if (this.propsSnapshot) {
            for (const section of def.sections) {
                for (const prop of section.properties) {
                    if (prop.type === 'button' || prop.type === 'vector3') continue;
                    const id = `${section.label}-${prop.label}`.replace(/\s+/g, '-').toLowerCase();
                    const val = this.propsSnapshot.get(id);
                    if (val !== undefined) (prop as any).set(val);
                }
            }
        }
        if (this.texturesSnapshot) {
            for (const [groupName, tex] of this.texturesSnapshot) {
                element.setGroupTexture(groupName, tex);
            }
        }
    }
}
