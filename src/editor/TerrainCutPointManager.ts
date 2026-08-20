import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import WorldNode from '../elements/WorldNode';
import SceneManager from './SceneManager';
import Config from '../utils/Config';
import type { PropertyDefinition } from './Properties';
import type { TerrainCutPointInput } from '../terrain/TerrainMesher';

export const DEFAULT_CUT_POINT_RADIUS = 4;

@singleton()
export default class TerrainCutPointManager {
    private readonly cutPoints: WorldNode[] = [];
    private readonly radii = new Map<WorldNode, number>();

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
    ) {}

    public addPoint(position: THREE.Vector3): WorldNode {
        const node = new WorldNode(position, Config.editor.terrainCutNodeColor);
        node.mesh.userData.terrainCutPoint = true;
        this.cutPoints.push(node);
        this.radii.set(node, DEFAULT_CUT_POINT_RADIUS);
        this.scene.instance.add(node.mesh);
        this.scene.markTerrainDirty();
        return node;
    }

    public getRadius(node: WorldNode): number {
        return this.radii.get(node) ?? DEFAULT_CUT_POINT_RADIUS;
    }

    public setRadius(node: WorldNode, radius: number): void {
        if (!this.radii.has(node)) return;
        this.radii.set(node, Math.max(0.1, radius));
        this.scene.markTerrainDirty();
    }

    public getPointsWithRadius(): TerrainCutPointInput[] {
        return this.cutPoints.map((node) => ({
            position: node.mesh.position.clone(),
            radius: this.getRadius(node),
        }));
    }

    public removePoint(node: WorldNode): void {
        const index = this.cutPoints.indexOf(node);
        if (index < 0) return;
        this.cutPoints.splice(index, 1);
        this.radii.delete(node);
        this.scene.instance.remove(node.mesh);
        node.dispose();
        this.scene.markTerrainDirty();
    }

    public clear(): void {
        for (const node of this.cutPoints) {
            this.scene.instance.remove(node.mesh);
            node.dispose();
        }
        this.cutPoints.length = 0;
        this.radii.clear();
        this.scene.markTerrainDirty();
    }

    public getPoints(): WorldNode[] {
        return [...this.cutPoints];
    }

    public serialize(): { x: number; y: number; z: number; radius: number }[] {
        return this.cutPoints.map((node) => ({
            x: node.mesh.position.x,
            y: node.mesh.position.y,
            z: node.mesh.position.z,
            radius: this.getRadius(node),
        }));
    }

    public load(points: { x: number; y: number; z: number; radius?: number }[]): void {
        this.clear();
        for (const point of points) {
            const node = new WorldNode(new THREE.Vector3(point.x, point.y, point.z), Config.editor.terrainCutNodeColor);
            node.mesh.userData.terrainCutPoint = true;
            this.cutPoints.push(node);
            this.radii.set(node, point.radius ?? DEFAULT_CUT_POINT_RADIUS);
            this.scene.instance.add(node.mesh);
        }
        this.scene.markTerrainDirty();
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
                        set: (value: THREE.Vector3) => { node.update(value); this.scene.markTerrainDirty(); },
                    },
                    {
                        type: 'number',
                        label: 'Distance',
                        get: () => this.getRadius(node),
                        set: (value: number) => { this.setRadius(node, value); },
                        min: 0.1,
                        max: 100,
                        step: 0.1,
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
