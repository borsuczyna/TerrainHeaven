import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import TerrainCutSpline from '../../elements/TerrainCutSpline';
import Camera from '../Camera';
import HistoryManager from '../HistoryManager';
import SceneManager from '../SceneManager';
import SplinePlacementTool from './SplinePlacementTool';
import PresetManager from '../PresetManager';

@singleton()
export default class TerrainCutSplineTool extends SplinePlacementTool<TerrainCutSpline> {
    public readonly name = 'terrain-cut-spline';
    protected readonly historyLabel = 'Add Terrain Cut Spline';

    constructor(
        @inject(SceneManager) scene: SceneManager,
        @inject(Camera) camera: Camera,
        @inject(HistoryManager) history: HistoryManager,
        @inject(PresetManager) presets: PresetManager,
    ) {
        super(scene, camera, history, presets);
    }

    protected createElement(start: THREE.Vector3, end: THREE.Vector3): TerrainCutSpline {
        return new TerrainCutSpline(start, end);
    }
}
