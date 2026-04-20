import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import SceneManager from './SceneManager';
import type { ProjectSettingsData } from './ProjectSettings';
import ProjectSettings from './ProjectSettings';
import Road from '../elements/Road';
import Intersection from '../elements/Intersection';
import type WorldElement from '../elements/WorldElement';

interface ElementData {
    type: 'road' | 'intersection';
    id: number;
    nodes: { x: number; y: number; z: number }[];
    textures: Record<string, string>; // groupName -> texture URL
    textureRotations: Record<string, number>;
    // Road-specific
    width?: number;
    lanes?: number;
    divisions?: number;
    edgeType?: string;
    sidewalkWidth?: number;
    curbHeight?: number;
    curvePointA?: { x: number; y: number; z: number } | null;
    curvePointB?: { x: number; y: number; z: number } | null;
    // Intersection-specific
    length?: number;
    nodeCount?: number;
    roadTexWidth?: number;
    roadTexHeight?: number;
    roadTexOffsetX?: number;
    roadTexOffsetY?: number;
}

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
            const textures: Record<string, string> = {};
            const textureRotations: Record<string, number> = {};

            for (const groupName of el.getGroupNames()) {
                const tex = el.getGroupTexture(groupName);
                const src = tex?.image instanceof HTMLImageElement ? tex.image.src : undefined;
                if (src) {
                    textures[groupName] = src;
                }
                const rot = el.textureRotations.get(groupName);
                if (rot) textureRotations[groupName] = rot;
            }

            if (el instanceof Road) {
                const nodes = [
                    { x: el.getNode(0).mesh.position.x, y: el.getNode(0).mesh.position.y, z: el.getNode(0).mesh.position.z },
                    { x: el.getNode(1).mesh.position.x, y: el.getNode(1).mesh.position.y, z: el.getNode(1).mesh.position.z },
                ];

                let curvePointA: { x: number; y: number; z: number } | null = null;
                let curvePointB: { x: number; y: number; z: number } | null = null;

                if (el.divisions > 0) {
                    const cpA = el.getCurvePointAPosition();
                    const cpB = el.getCurvePointBPosition();
                    if (cpA) curvePointA = { x: cpA.x, y: cpA.y, z: cpA.z };
                    if (cpB) curvePointB = { x: cpB.x, y: cpB.y, z: cpB.z };
                }

                elementDataList.push({
                    type: 'road', id, nodes, textures, textureRotations,
                    width: el.width,
                    lanes: el.lanes,
                    divisions: el.divisions,
                    edgeType: el.edgeType,
                    sidewalkWidth: el.sidewalkWidth,
                    curbHeight: el.curbHeight,
                    curvePointA,
                    curvePointB,
                });
            } else if (el instanceof Intersection) {
                const nodes = [];
                for (let i = 0; i < el.nodeCount; i++) {
                    const p = el.getNode(i).mesh.position;
                    nodes.push({ x: p.x, y: p.y, z: p.z });
                }

                elementDataList.push({
                    type: 'intersection', id, nodes, textures, textureRotations,
                    width: el.width,
                    length: el.length,
                    nodeCount: el.nodeCount,
                    edgeType: el.edgeType,
                    sidewalkWidth: el.sidewalkWidth,
                    curbHeight: el.curbHeight,
                    roadTexWidth: el.roadTexWidth,
                    roadTexHeight: el.roadTexHeight,
                    roadTexOffsetX: el.roadTexOffsetX,
                    roadTexOffsetY: el.roadTexOffsetY,
                });
            }
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
            if (ed.type === 'road') {
                const posA = new THREE.Vector3(ed.nodes[0].x, ed.nodes[0].y, ed.nodes[0].z);
                const posB = new THREE.Vector3(ed.nodes[1].x, ed.nodes[1].y, ed.nodes[1].z);
                const road = new Road(posA, posB);
                road.width = ed.width ?? 3;
                road.lanes = ed.lanes ?? 2;
                road.edgeType = (ed.edgeType as 'none' | 'sidewalk') ?? 'none';
                road.sidewalkWidth = ed.sidewalkWidth ?? 1;
                road.curbHeight = ed.curbHeight ?? 0.15;

                if (ed.divisions && ed.divisions > 0) {
                    road.divisions = ed.divisions;
                    if (ed.curvePointA) {
                        road.setCurvePointA(new THREE.Vector3(ed.curvePointA.x, ed.curvePointA.y, ed.curvePointA.z));
                    }
                    if (ed.curvePointB) {
                        road.setCurvePointB(new THREE.Vector3(ed.curvePointB.x, ed.curvePointB.y, ed.curvePointB.z));
                    }
                }

                this.loadTextures(road, ed.textures, ed.textureRotations);
                this.scene.add(road);
                elements.push(road);
            } else if (ed.type === 'intersection') {
                const center = new THREE.Vector3();
                for (const n of ed.nodes) center.add(new THREE.Vector3(n.x, n.y, n.z));
                center.divideScalar(ed.nodes.length);

                const intersection = new Intersection(center, ed.nodeCount ?? 4);
                intersection.width = ed.width ?? 3;
                intersection.length = ed.length ?? 3;
                intersection.edgeType = (ed.edgeType as 'none' | 'sidewalk') ?? 'none';
                intersection.sidewalkWidth = ed.sidewalkWidth ?? 1;
                intersection.curbHeight = ed.curbHeight ?? 0.15;
                intersection.roadTexWidth = ed.roadTexWidth ?? 3;
                intersection.roadTexHeight = ed.roadTexHeight ?? 3;
                intersection.roadTexOffsetX = ed.roadTexOffsetX ?? 0;
                intersection.roadTexOffsetY = ed.roadTexOffsetY ?? 0;

                // Move nodes to saved positions
                for (let i = 0; i < ed.nodes.length; i++) {
                    const n = ed.nodes[i];
                    intersection.getNode(i).update(new THREE.Vector3(n.x, n.y, n.z));
                }

                this.loadTextures(intersection, ed.textures, ed.textureRotations);
                this.scene.add(intersection);
                elements.push(intersection);
            }
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
