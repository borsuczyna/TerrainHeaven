import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import Road from '../../elements/Road';
import Camera from '../Camera';
import HistoryManager from '../HistoryManager';
import SceneManager from '../SceneManager';
import SplinePlacementTool from './SplinePlacementTool';

@singleton()
export default class RoadTool extends SplinePlacementTool<Road> {
    public readonly name = 'road';
    protected readonly historyLabel = 'Add Road';

    constructor(
        @inject(SceneManager) scene: SceneManager,
        @inject(Camera) camera: Camera,
        @inject(HistoryManager) history: HistoryManager,
    ) {
        super(scene, camera, history);
    }

    protected createElement(start: THREE.Vector3, end: THREE.Vector3): Road {
        return new Road(start, end);
    }
}
