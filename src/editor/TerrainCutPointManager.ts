import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import WorldNode from '../elements/WorldNode';
import SceneManager from './SceneManager';
import Config from '../utils/Config';
import type { PropertyDefinition } from './Properties';

@singleton()
export default class TerrainCutPointManager {
    private readonly cutPoints: WorldNode[] = [];

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
    ) {}

    public addPoint(position: THREE.Vector3): WorldNode {
        const node = new WorldNode(position, Config.editor.terrainCutNodeColor);
        node.mesh.userData.terrainCutPoint = true;
        this.cutPoints.push(node);
        this.scene.instance.add(node.mesh);
        this.scene.update();
        return node;
    }

    public removePoint(node: WorldNode): void {
        const index = this.cutPoints.indexOf(node);
        if (index < 0) return;
        this.cutPoints.splice(index, 1);
        this.scene.instance.remove(node.mesh);
        this.scene.update();
    }

    public clear(): void {
        for (const node of this.cutPoints) {
            this.scene.instance.remove(node.mesh);
        }
        this.cutPoints.length = 0;
    }

    public getPoints(): WorldNode[] {
        return [...this.cutPoints];
    }

    public serialize(): { x: number; y: number; z: number }[] {
        return this.cutPoints.map((node) => ({
            x: node.mesh.position.x,
            y: node.mesh.position.y,
            z: node.mesh.position.z,
        }));
    }

    public load(points: { x: number; y: number; z: number }[]): void {
        this.clear();
        for (const point of points) {
            const node = new WorldNode(new THREE.Vector3(point.x, point.y, point.z), Config.editor.terrainCutNodeColor);
            node.mesh.userData.terrainCutPoint = true;
            this.cutPoints.push(node);
            this.scene.instance.add(node.mesh);
        }
        this.scene.update();
    }

    public isCutPoint(node: WorldNode): boolean {
        return this.cutPoints.includes(node);
    }

    public getProperties(node: WorldNode): PropertyDefinition | null {
        if (!this.isCutPoint(node)) return null;
        return {
            title: 'Terrain Cut Point',
            icon: '&#9679;',
            sections: [{
                label: 'Cut Point',
                properties: [
                    {
                        type: 'vector3',
                        label: 'Position',
                        get: () => node.mesh.position.clone(),
                        set: (value: THREE.Vector3) => { node.update(value); this.scene.update(); },
                    },
                    {
                        type: 'button',
                        label: 'Remove',
                        onClick: () => { this.removePoint(node); },
                    },
                ],
            }],
        };
    }
}