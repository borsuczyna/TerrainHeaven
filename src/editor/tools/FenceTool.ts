import * as THREE from 'three';
import { inject, singleton } from 'tsyringe';
import Fence from '../../elements/Fence';
import Camera from '../Camera';
import HistoryManager from '../HistoryManager';
import SceneManager from '../SceneManager';
import SplinePlacementTool from './SplinePlacementTool';
import PresetManager from '../PresetManager';

@singleton()
export default class FenceTool extends SplinePlacementTool<Fence> {
    public readonly name = 'fence';
    protected readonly historyLabel = 'Add Fence';

    constructor(
        @inject(SceneManager) scene: SceneManager,
        @inject(Camera) camera: Camera,
        @inject(HistoryManager) history: HistoryManager,
        @inject(PresetManager) presets: PresetManager,
    ) {
        super(scene, camera, history, presets);
    }

    protected createElement(start: THREE.Vector3, end: THREE.Vector3): Fence {
        return new Fence(start, end);
    }
}
