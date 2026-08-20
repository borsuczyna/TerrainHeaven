import { singleton, inject } from 'tsyringe';
import SceneManager from './SceneManager';
import type { ProjectSettingsData } from './ProjectSettings';
import ProjectSettings from './ProjectSettings';
import Road from '../elements/Road';
import Intersection from '../elements/Intersection';
import Terrain from '../elements/Terrain.ts';
import TerrainCutSpline from '../elements/TerrainCutSpline';
import RiverSpline from '../elements/RiverSpline';
import type WorldElement from '../elements/WorldElement';
import type { ElementData } from '../elements/WorldElement';
import TerrainCutPointManager from './TerrainCutPointManager';
import TextureLibrary from './TextureLibrary';
import FoliageManager from './FoliageManager';
import type { FoliageProjectData } from '../foliage/FoliageData';

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
    terrainCutPoints?: { x: number; y: number; z: number; radius?: number }[];
    texturePaths?: string[];
    foliage?: FoliageProjectData;
}

@singleton()
export default class ProjectSerializer {
    private scene: SceneManager;
    private settings: ProjectSettings;

    constructor(
        @inject(SceneManager) scene: SceneManager,
        @inject(ProjectSettings) settings: ProjectSettings,
        @inject(TerrainCutPointManager) private readonly terrainCutPoints: TerrainCutPointManager,
        @inject(TextureLibrary) private readonly textureLibrary: TextureLibrary,
        @inject(FoliageManager) private readonly foliage: FoliageManager,
    ) {
        this.scene = scene;
        this.settings = settings;
        this.textureLibrary.onAssetAvailable = (path) => {
            this.reloadTexturePath(path);
            this.foliage.commitChanges();
        };
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

        const foliage = this.foliage.serialize();
        const projectData: ProjectData = {
            version: 1,
            settings: this.settings.getData(),
            elements: elementDataList,
            connections,
            terrainCutPoints: this.terrainCutPoints.serialize(),
            texturePaths: [...new Set([
                ...elementDataList.flatMap((element) => Object.values(element.textures)),
                ...foliage.Types.map((type) => type.TexturePath),
            ].filter(Boolean))],
            foliage,
        };

        return JSON.stringify(projectData, null, 2);
    }

    public load(json: string): void {
        const data: ProjectData = JSON.parse(json);
        if (data.version !== 1) throw new Error('Unsupported project version');

        // Clear current scene
        this.scene.clearElements();
        this.terrainCutPoints.clear();

        // Load settings
        this.settings.loadData(data.settings);
        const texturePaths = [
            ...data.elements.flatMap((element) =>
                Object.values(element.textures ?? {}).map((path) => this.normalizeProjectTexturePath(path)),
            ),
            ...(data.foliage?.Types ?? []).map((type) => this.normalizeProjectTexturePath(type.TexturePath)),
        ];
        void this.textureLibrary.setProjectReferences(texturePaths);

        // Create elements
        const elements: WorldElement[] = [];
        for (const ed of data.elements) {
            let el: WorldElement | null = null;
            if (ed.type === 'road') {
                el = Road.deserialize(ed);
            } else if (ed.type === 'intersection') {
                el = Intersection.deserialize(ed);
            } else if (ed.type === 'terrain') {
                el = Terrain.deserialize(ed);
            } else if (ed.type === 'terrainCutSpline') {
                el = TerrainCutSpline.deserialize(ed);
            } else if (ed.type === 'river') {
                el = RiverSpline.deserialize(ed);
            }
            if (!el) continue;
            const textureReferences = Object.fromEntries(
                Object.entries(ed.textures ?? {}).map(([groupName, path]) => [groupName, this.normalizeProjectTexturePath(path)]),
            );
            this.loadTextures(el, textureReferences, ed.textureRotations);
            this.scene.add(el, false);
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

        this.terrainCutPoints.load(data.terrainCutPoints ?? []);
        this.foliage.load(data.foliage);

        // Update all
        this.scene.update();
    }

    private loadTextures(element: WorldElement, textures: Record<string, string>, rotations: Record<string, number>): void {
        for (const [groupName, path] of Object.entries(textures)) {
            element.setGroupTextureReference(groupName, path);
            void this.textureLibrary.loadTexture(path).then((texture) => {
                if (texture) element.setGroupTexture(groupName, texture, path);
            });
        }
        for (const [groupName, deg] of Object.entries(rotations)) {
            element.textureRotations.set(groupName, deg);
        }
    }

    private reloadTexturePath(path: string): void {
        for (const element of this.scene.getElements()) {
            for (const [groupName, sourcePath] of element.getGroupTextureReferences()) {
                if (sourcePath !== path) continue;
                void this.textureLibrary.loadTexture(path).then((texture) => {
                    if (texture) element.setGroupTexture(groupName, texture, path);
                });
            }
        }
    }

    private normalizeProjectTexturePath(source: string): string {
        if (source.startsWith('data:')) {
            let hash = 2166136261;
            for (let index = 0; index < source.length; index++) {
                hash ^= source.charCodeAt(index);
                hash = Math.imul(hash, 16777619);
            }
            return `legacy-texture-${(hash >>> 0).toString(16)}.png`;
        }

        try {
            const url = new URL(source);
            return decodeURIComponent(url.pathname.split('/').pop() || 'texture.png');
        } catch {
            return source.replace(/\\/g, '/').replace(/^\.\//, '');
        }
    }
}
