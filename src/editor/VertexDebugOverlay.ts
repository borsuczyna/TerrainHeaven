import { singleton, inject } from 'tsyringe';
import Camera from './Camera';
import SelectionManager from './SelectionManager';

interface VertexDebugRow {
    index: number;
    group: string;
    label: string;
    x: number;
    y: number;
    z: number;
    triangle: number;
    triangleMates: string;
    coincidentWith: string;
}

// On-screen vertex ID labels for whatever element is currently selected, plus a
// window.getVertices() console tool that dumps what each vertex actually is (role,
// which triangle/group it belongs to, which other vertices sit at the same position).
// Built so mismatched-geometry bugs (e.g. a corner that looks connected but isn't) can be
// pointed at by exact vertex index instead of guessed at from a screenshot.
@singleton()
export default class VertexDebugOverlay {
    private readonly container: HTMLDivElement;
    private readonly labelPool: HTMLDivElement[] = [];

    constructor(
        @inject(Camera) private readonly camera: Camera,
        @inject(SelectionManager) private readonly selection: SelectionManager,
    ) {
        this.container = document.createElement('div');
        this.container.id = 'vertex-debug-overlay';
        this.container.style.pointerEvents = 'none';
        document.body.appendChild(this.container);

        (window as unknown as { getVertices: () => VertexDebugRow[] }).getVertices = () => this.describeSelectedVertices();
    }

    public update(): void {
        const element = this.selection.getSelectedElement();
        const info = element?.getVertexDebugInfo() ?? [];
        if (info.length === 0) {
            for (const div of this.labelPool) div.style.display = 'none';
            return;
        }

        const cameraInstance = this.camera.instance;
        const groups = new Map<string, { x: number; y: number; ids: number[] }>();
        for (const v of info) {
            const projected = v.position.clone().project(cameraInstance);
            if (projected.z < -1 || projected.z > 1) continue;
            const x = (projected.x + 1) * 0.5 * window.innerWidth;
            const y = (1 - projected.y) * 0.5 * window.innerHeight;
            // Vertices that coincide on screen (same corner shared by multiple triangles)
            // are merged into one label - round to a small pixel bucket rather than
            // requiring an exact match.
            const key = `${Math.round(x / 4)}_${Math.round(y / 4)}`;
            let group = groups.get(key);
            if (!group) { group = { x, y, ids: [] }; groups.set(key, group); }
            group.ids.push(v.index);
        }

        const groupList = [...groups.values()];
        while (this.labelPool.length < groupList.length) {
            const div = document.createElement('div');
            div.style.position = 'fixed';
            div.style.transform = 'translate(-50%, -50%)';
            div.style.color = '#fff';
            div.style.font = '700 11px monospace';
            div.style.textShadow = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000';
            div.style.pointerEvents = 'none';
            div.style.whiteSpace = 'nowrap';
            div.style.zIndex = '99999';
            this.container.appendChild(div);
            this.labelPool.push(div);
        }

        for (let i = 0; i < this.labelPool.length; i++) {
            const div = this.labelPool[i];
            const group = groupList[i];
            if (!group) { div.style.display = 'none'; continue; }
            div.style.display = 'block';
            div.style.left = `${group.x}px`;
            div.style.top = `${group.y}px`;
            div.textContent = group.ids.join(',');
        }
    }

    public describeSelectedVertices(): VertexDebugRow[] {
        const element = this.selection.getSelectedElement();
        if (!element) {
            console.warn('[getVertices] Nothing selected - click an element in the viewport first.');
            return [];
        }

        const info = element.getVertexDebugInfo();
        if (info.length === 0) {
            console.warn('[getVertices] Selected element has no built geometry.');
            return [];
        }

        const EPS = 1e-4;
        const rows: VertexDebugRow[] = info.map((v) => {
            const triangleStart = Math.floor(v.index / 3) * 3;
            const triangleMates = [triangleStart, triangleStart + 1, triangleStart + 2]
                .filter((i) => i !== v.index);
            const coincidentWith = info
                .filter((o) => o.index !== v.index && o.position.distanceTo(v.position) < EPS)
                .map((o) => o.index);

            return {
                index: v.index,
                group: v.group,
                label: v.label || '(unlabeled)',
                x: Number(v.position.x.toFixed(3)),
                y: Number(v.position.y.toFixed(3)),
                z: Number(v.position.z.toFixed(3)),
                triangle: Math.floor(v.index / 3),
                triangleMates: triangleMates.join(','),
                coincidentWith: coincidentWith.join(',') || '-',
            };
        });

        console.log(`[getVertices] ${element.constructor.name}: ${rows.length} vertices`);
        console.table(rows);
        return rows;
    }
}
