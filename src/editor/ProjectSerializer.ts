import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import SceneManager from './SceneManager';
import type { ProjectSettingsData } from './ProjectSettings';
import ProjectSettings from './ProjectSettings';
import Road from '../elements/Road';
import Intersection from '../elements/Intersection';
import type WorldElement from '../elements/WorldElement';
import type { ElementData } from '../elements/WorldElement';

interface ConnectionData {
    elementA: number;
    nodeA: number;
    elementB: number;
    nodeB: number;
}

interface ProjectData {
    version: 1;
    settings: ProjectSettingsData;
    elements: ElementData[];
    connections: ConnectionData[];
}

@singleton()
export default class ProjectSerializer {
    private scene: SceneManager;
    private settings: ProjectSettings;

    constructor(
        @inject(SceneManager) scene: SceneManager,
        @inject(ProjectSettings) settings: ProjectSettings,
    ) {
        this.scene = scene;
        this.settings = settings;
    }

    public save(): string {
        const elements = this.scene.getElements();
        const elementMap = new Map<WorldElement, number>();
        const elementDataList: ElementData[] = [];
        const connections: ConnectionData[] = [];

        elements.forEach((el, i) => elementMap.set(el, i));

        for (const el of elements) {
            const id = elementMap.get(el)!;
            elementDataList.push(el.serialize(id));
        }

        // Collect connections (avoid duplicates)
        const connSeen = new Set<string>();
        for (const el of elements) {
            const idA = elementMap.get(el)!;
            for (const [nodeA, conn] of el.connections) {
                const idB = elementMap.get(conn.element)!;
                const key = [Math.min(idA, idB), Math.max(idA, idB),
                    idA < idB ? nodeA : conn.nodeIndex,
                    idA < idB ? conn.nodeIndex : nodeA].join(',');
                if (!connSeen.has(key)) {
                    connSeen.add(key);
                    connections.push({ elementA: idA, nodeA, elementB: idB, nodeB: conn.nodeIndex });
                }
            }
        }

        const projectData: ProjectData = {
            version: 1,
            settings: this.settings.getData(),
            elements: elementDataList,
            connections,
        };

        return JSON.stringify(projectData, null, 2);
    }

    public load(json: string): void {
        const data: ProjectData = JSON.parse(json);
        if (data.version !== 1) throw new Error('Unsupported project version');

        // Clear current scene
        this.scene.clearElements();

        // Load settings
        this.settings.loadData(data.settings);

        // Create elements
        const elements: WorldElement[] = [];
        for (const ed of data.elements) {
            let el: WorldElement | null = null;
            if (ed.type === 'road') {
                el = Road.deserialize(ed);
            } else if (ed.type === 'intersection') {
                el = Intersection.deserialize(ed);
            }
            if (!el) continue;
            this.loadTextures(el, ed.textures, ed.textureRotations);
            this.scene.add(el);
            elements.push(el);
        }

        // Restore connections
        for (const conn of data.connections) {
            const elA = elements[conn.elementA];
            const elB = elements[conn.elementB];
            if (elA && elB) {
                elA.connect(conn.nodeA, elB, conn.nodeB);
            }
        }

        // Update all
        this.scene.update();
    }

    private loadTextures(element: WorldElement, textures: Record<string, string>, rotations: Record<string, number>): void {
        const loader = new THREE.TextureLoader();
        for (const [groupName, url] of Object.entries(textures)) {
            loader.load(url, (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.colorSpace = THREE.SRGBColorSpace;
                element.setGroupTexture(groupName, tex);
            });
        }
        for (const [groupName, deg] of Object.entries(rotations)) {
            element.textureRotations.set(groupName, deg);
        }
    }
}
