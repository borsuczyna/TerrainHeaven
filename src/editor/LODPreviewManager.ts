import { inject, singleton } from 'tsyringe';
import SceneManager from './SceneManager';

// A transient, session-only preview aid for checking what the Unity exporter's LOD
// levels will actually look like before exporting. Deliberately NOT part of
// ProjectSettings/serialization - reopening a saved project should never silently start
// in a coarsened preview. Shares its coarsening formulas with the exporter
// (src/export/LODLevels.ts) via the elements' own getGeometry(), so previewing a level
// is a faithful look at what that export level will produce, not a separate rendering.
@singleton()
export default class LODPreviewManager {
    private currentLevel = 0;

    constructor(@inject(SceneManager) private readonly scene: SceneManager) {}

    public get level(): number {
        return this.currentLevel;
    }

    public setLevel(level: number): void {
        const clamped = Math.max(0, Math.min(3, Math.round(level)));
        if (clamped === this.currentLevel) return;
        this.currentLevel = clamped;
        this.scene.update();
    }
}
