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
    private readonly listeners = new Set<() => void>();

    constructor(@inject(SceneManager) private readonly scene: SceneManager) {}

    public get level(): number {
        return this.currentLevel;
    }

    public setLevel(level: number): void {
        const clamped = Math.max(0, Math.min(3, Math.round(level)));
        if (clamped === this.currentLevel) return;
        this.currentLevel = clamped;
        this.scene.update();
        for (const listener of this.listeners) listener();
    }

    // WorldElements pull `.level` themselves inside their own getGeometry(), rebuilt by
    // the scene.update() call above. MeshManager isn't a WorldElement (it's a top-level
    // instanced-mesh group like FoliageManager), so it needs an explicit hook instead to
    // know when to swap each prop's geometry to the matching LOD.
    public onLevelChanged(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
