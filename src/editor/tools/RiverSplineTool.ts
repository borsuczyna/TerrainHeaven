import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import RiverSpline from '../../elements/RiverSpline';
import Camera from '../Camera';
import HistoryManager from '../HistoryManager';
import SceneManager from '../SceneManager';
import SplinePlacementTool from './SplinePlacementTool';

@singleton()
export default class RiverSplineTool extends SplinePlacementTool<RiverSpline> {
    public readonly name = 'river';
    protected readonly historyLabel = 'Add River Spline';

    constructor(
        @inject(SceneManager) scene: SceneManager,
        @inject(Camera) camera: Camera,
        @inject(HistoryManager) history: HistoryManager,
    ) {
        super(scene, camera, history);
    }

    protected createElement(start: THREE.Vector3, end: THREE.Vector3): RiverSpline {
        return new RiverSpline(start, end);
    }
}
