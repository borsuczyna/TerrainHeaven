import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type WorldElement from '../../elements/WorldElement';
import type { UVTransform } from '../../elements/WorldElement';
import HistoryManager from '../HistoryManager';

@singleton()
export default class UVEditorPanel {
    private container: HTMLElement;
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private groupSelect: HTMLSelectElement;
    private element: WorldElement | null = null;
    private activeGroup: string = '';
    private textureImage: HTMLImageElement | null = null;

    // Pan/zoom for the editor viewport
    private viewOffsetX = 0;
    private viewOffsetY = 0;
    private viewZoom = 1;

    // Drag state
    private dragging: 'move' | 'scale' | null = null;
    private dragStartX = 0;
    private dragStartY = 0;
    private dragStartTransform: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

    // Scale handle
    private scaleHandleSize = 10;

    public onChange: (() => void) | null = null;
    public onHide: (() => void) | null = null;

    constructor(@inject(HistoryManager) private readonly history: HistoryManager) {
        // Build DOM
        this.container = document.createElement('div');
        this.container.id = 'uv-editor';
        this.container.innerHTML = `
            <div class="uv-header">
                <span class="uv-title">UV Editor</span>
                <select class="uv-group-select"></select>
                <button class="uv-close">&times;</button>
            </div>
            <canvas class="uv-canvas"></canvas>
            <div class="uv-footer">
                <span class="uv-info"></span>
            </div>
        `;
        document.body.appendChild(this.container);

        this.canvas = this.container.querySelector('.uv-canvas')!;
        this.ctx = this.canvas.getContext('2d')!;
        this.groupSelect = this.container.querySelector('.uv-group-select')!;

        this.groupSelect.addEventListener('change', () => {
            this.activeGroup = this.groupSelect.value;
            this.loadGroupTexture();
            this.draw();
        });

        this.container.querySelector('.uv-close')!.addEventListener('click', () => this.hide());

        this.canvas.addEventListener('mousedown', this.onMouseDown);
        this.canvas.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
        this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Make panel draggable by header
        const header = this.container.querySelector('.uv-header')! as HTMLElement;
        header.style.cursor = 'move';
        header.addEventListener('mousedown', (e) => {
            if ((e.target as HTMLElement).tagName === 'SELECT') return;
            if ((e.target as HTMLElement).tagName === 'BUTTON') return;
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            const rect = this.container.getBoundingClientRect();
            const startLeft = rect.left;
            const startTop = rect.top;

            const onMove = (ev: MouseEvent) => {
                this.container.style.left = (startLeft + ev.clientX - startX) + 'px';
                this.container.style.top = (startTop + ev.clientY - startY) + 'px';
                this.container.style.transform = 'none';
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        this.hide();
        window.addEventListener('history-restored', this.onHistoryRestored);
    }

    public show(element: WorldElement): void {
        this.element = element;
        const groups = element.getUVGroups();
        if (groups.length === 0) {
            this.hide();
            return;
        }

        // Populate group select
        this.groupSelect.innerHTML = '';
        for (const g of groups) {
            const opt = document.createElement('option');
            opt.value = g;
            opt.textContent = g;
            this.groupSelect.appendChild(opt);
        }
        this.activeGroup = groups[0];
        this.groupSelect.value = this.activeGroup;

        this.loadGroupTexture();
        this.container.classList.add('visible');
        // Delay resize + draw to ensure the container has layout
        requestAnimationFrame(() => {
            this.resizeCanvas();
            this.draw();
        });
    }

    public hide(): void {
        this.container.classList.remove('visible');
        this.element = null;
        this.textureImage = null;
        this.onHide?.();
    }

    public get visible(): boolean {
        return this.container.classList.contains('visible');
    }

    public getElement(): WorldElement | null {
        return this.element;
    }

    public refresh(): void {
        if (this.visible && this.element) {
            this.draw();
        }
    }

    private loadGroupTexture(): void {
        if (!this.element) return;
        const tex = this.element.getGroupTexture(this.activeGroup);
        if (tex?.image) {
            this.textureImage = tex.image as HTMLImageElement;
        } else {
            this.textureImage = null;
        }
    }

    private resizeCanvas(): void {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        this.canvas.width = w * window.devicePixelRatio;
        this.canvas.height = h * window.devicePixelRatio;
        this.ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    }

    private draw(): void {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (w === 0 || h === 0) return;

        // Refresh texture reference in case it was changed externally
        this.loadGroupTexture();

        // Ensure canvas size matches
        if (this.canvas.width !== w * window.devicePixelRatio || this.canvas.height !== h * window.devicePixelRatio) {
            this.resizeCanvas();
        }

        const ctx = this.ctx;
        ctx.clearRect(0, 0, w, h);

        // Background
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, w, h);

        // Draw checker pattern for "UV space"
        this.drawCheckerboard(w, h);

        // Draw texture tiles at FIXED UV positions (0,0 → 1,1 and repeating)
        this.drawTextureTiles(w, h);

        if (!this.element || !this.activeGroup) return;

        // Draw UV wireframe from actual geometry (these move when offset/scale changes)
        this.drawUVWireframe(w, h);

        // Draw the wireframe bounding box with scale handles
        this.drawWireframeBounds(w, h);

        // Info text
        const transform = this.element.getUVTransform(this.activeGroup);
        const info = this.container.querySelector('.uv-info')!;
        info.textContent = `Offset: ${transform.offsetX.toFixed(2)}, ${transform.offsetY.toFixed(2)} | Scale: ${transform.scaleX.toFixed(2)} x ${transform.scaleY.toFixed(2)}`;
    }

    private drawCheckerboard(w: number, h: number): void {
        const ctx = this.ctx;
        const cellSize = 20 * this.viewZoom;
        const startX = this.viewOffsetX % (cellSize * 2);
        const startY = this.viewOffsetY % (cellSize * 2);

        for (let y = startY - cellSize * 2; y < h; y += cellSize) {
            for (let x = startX - cellSize * 2; x < w; x += cellSize) {
                const col = Math.round((x - startX) / cellSize);
                const row = Math.round((y - startY) / cellSize);
                ctx.fillStyle = (col + row) % 2 === 0 ? '#222' : '#2a2a2a';
                ctx.fillRect(x, y, cellSize, cellSize);
            }
        }

        // Draw UV space origin lines
        const originX = w / 2 + this.viewOffsetX;
        const originY = h / 2 + this.viewOffsetY;
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(originX, 0);
        ctx.lineTo(originX, h);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(80, 255, 80, 0.3)';
        ctx.beginPath();
        ctx.moveTo(0, originY);
        ctx.lineTo(w, originY);
        ctx.stroke();
    }

    /** Convert UV coordinate to canvas pixel position */
    private uvToCanvas(u: number, v: number, w: number, h: number): [number, number] {
        const unitSize = 100 * this.viewZoom;
        const cx = w / 2 + this.viewOffsetX;
        const cy = h / 2 + this.viewOffsetY;
        return [cx + u * unitSize, cy + v * unitSize];
    }

    private drawTextureTiles(w: number, h: number): void {
        if (!this.textureImage) return;
        const ctx = this.ctx;
        const unitSize = 100 * this.viewZoom;

        // Texture tiles are at FIXED UV positions: tile at (tx,ty) covers [tx, tx+1] x [ty, ty+1]
        const [ox, oy] = this.uvToCanvas(0, 0, w, h);
        const tilesX = Math.ceil(w / unitSize) + 2;
        const tilesY = Math.ceil(h / unitSize) + 2;

        // Calculate which tile is at top-left of visible area
        const startTX = Math.floor(-ox / unitSize) - 1;
        const startTY = Math.floor(-oy / unitSize) - 1;

        for (let ty = startTY; ty < startTY + tilesY + 2; ty++) {
            for (let tx = startTX; tx < startTX + tilesX + 2; tx++) {
                const [sx, sy] = this.uvToCanvas(tx, ty, w, h);
                // Main tile (0,0→1,1) is fully opaque, repeating tiles are dimmer
                const isMainTile = tx === 0 && ty === 0;
                ctx.globalAlpha = isMainTile ? 0.8 : 0.35;
                ctx.drawImage(this.textureImage, sx, sy, unitSize, unitSize);
            }
        }
        ctx.globalAlpha = 1;

        // Draw main tile border
        const [mx, my] = this.uvToCanvas(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 2;
        ctx.strokeRect(mx, my, unitSize, unitSize);
    }

    private drawUVWireframe(w: number, h: number): void {
        if (!this.element) return;
        const ctx = this.ctx;
        const geometry = this.element.mesh.geometry;
        if (!geometry) return;

        const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute;
        if (!uvAttr) return;

        // Find the group that matches activeGroup
        let groupStart = 0;
        let groupCount = uvAttr.count;
        const groups = geometry.groups;
        const groupNames = this.element.getGroupNames();
        for (let i = 0; i < groups.length; i++) {
            if (groupNames[i] === this.activeGroup) {
                groupStart = groups[i].start;
                groupCount = groups[i].count;
                break;
            }
        }

        // Draw filled triangles with semi-transparent fill
        ctx.fillStyle = 'rgba(100, 200, 255, 0.1)';
        ctx.strokeStyle = 'rgba(100, 200, 255, 0.7)';
        ctx.lineWidth = 1;

        for (let i = groupStart; i < groupStart + groupCount; i += 3) {
            const [x0, y0] = this.uvToCanvas(uvAttr.getX(i), uvAttr.getY(i), w, h);
            const [x1, y1] = this.uvToCanvas(uvAttr.getX(i + 1), uvAttr.getY(i + 1), w, h);
            const [x2, y2] = this.uvToCanvas(uvAttr.getX(i + 2), uvAttr.getY(i + 2), w, h);

            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }
    }

    private getWireframeBounds(w: number, h: number): { minX: number; minY: number; maxX: number; maxY: number } | null {
        if (!this.element) return null;
        const geometry = this.element.mesh.geometry;
        if (!geometry) return null;
        const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute;
        if (!uvAttr) return null;

        let groupStart = 0;
        let groupCount = uvAttr.count;
        const groups = geometry.groups;
        const groupNames = this.element.getGroupNames();
        for (let i = 0; i < groups.length; i++) {
            if (groupNames[i] === this.activeGroup) {
                groupStart = groups[i].start;
                groupCount = groups[i].count;
                break;
            }
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = groupStart; i < groupStart + groupCount; i++) {
            const [px, py] = this.uvToCanvas(uvAttr.getX(i), uvAttr.getY(i), w, h);
            minX = Math.min(minX, px);
            minY = Math.min(minY, py);
            maxX = Math.max(maxX, px);
            maxY = Math.max(maxY, py);
        }

        if (!isFinite(minX)) return null;
        return { minX, minY, maxX, maxY };
    }

    private drawWireframeBounds(w: number, h: number): void {
        const bounds = this.getWireframeBounds(w, h);
        if (!bounds) return;
        const ctx = this.ctx;
        const { minX, minY, maxX, maxY } = bounds;
        const s = this.scaleHandleSize;

        // Bounding box
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
        ctx.setLineDash([]);

        // Scale handle at bottom-right corner
        ctx.fillStyle = '#ffaa00';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.fillRect(maxX - s / 2, maxY - s / 2, s, s);
        ctx.strokeRect(maxX - s / 2, maxY - s / 2, s, s);

        // Move handle (small cross at center)
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 2;
        const cs = 8;
        ctx.beginPath();
        ctx.moveTo(cx - cs, cy); ctx.lineTo(cx + cs, cy);
        ctx.moveTo(cx, cy - cs); ctx.lineTo(cx, cy + cs);
        ctx.stroke();
    }

    private hitScaleHandle(mx: number, my: number): boolean {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        const bounds = this.getWireframeBounds(w, h);
        if (!bounds) return false;
        const s = this.scaleHandleSize + 6;
        return mx >= bounds.maxX - s / 2 && mx <= bounds.maxX + s / 2 &&
               my >= bounds.maxY - s / 2 && my <= bounds.maxY + s / 2;
    }

    private onMouseDown = (e: MouseEvent): void => {
        if (!this.element || !this.activeGroup) return;
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (e.button === 2 || (e.button === 0 && e.altKey)) {
            // Right-click or Alt+left: pan the view
            this.dragging = null;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            const startOffX = this.viewOffsetX;
            const startOffY = this.viewOffsetY;

            const onMove = (ev: MouseEvent) => {
                this.viewOffsetX = startOffX + (ev.clientX - this.dragStartX);
                this.viewOffsetY = startOffY + (ev.clientY - this.dragStartY);
                this.draw();
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
            e.preventDefault();
            return;
        }

        if (e.button !== 0) return;

        const transform = this.element.getUVTransform(this.activeGroup);
        this.dragStartTransform = { ...transform };
        this.dragStartX = mx;
        this.dragStartY = my;
        this.history.beginAction('Edit UV Mapping');

        if (this.hitScaleHandle(mx, my)) {
            this.dragging = 'scale';
        } else {
            this.dragging = 'move';
        }
        e.preventDefault();
    };

    private onMouseMove = (e: MouseEvent): void => {
        if (!this.dragging || !this.element || !this.activeGroup) {
            // Update cursor
            const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            this.canvas.style.cursor = this.hitScaleHandle(mx, my) ? 'nwse-resize' : 'grab';
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const unitSize = 100 * this.viewZoom;
        const dx = (mx - this.dragStartX) / unitSize;
        const dy = (my - this.dragStartY) / unitSize;

        const t = { ...this.dragStartTransform };

        if (this.dragging === 'move') {
            t.offsetX += dx;
            t.offsetY += dy;
        } else if (this.dragging === 'scale') {
            t.scaleX = Math.max(0.1, this.dragStartTransform.scaleX - dx);
            t.scaleY = Math.max(0.1, this.dragStartTransform.scaleY - dy);
        }

        this.element.setUVTransform(this.activeGroup, t);
        this.onChange?.();
        this.draw();
    };

    private onMouseUp = (): void => {
        if (this.dragging) {
            this.canvas.style.cursor = 'grab';
            this.history.endAction('Edit UV Mapping');
        }
        this.dragging = null;
    };

    private onHistoryRestored = (): void => {
        this.hide();
    };

    private onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Zoom towards mouse position
        const oldZoom = this.viewZoom;
        this.viewZoom = Math.max(0.1, Math.min(10, this.viewZoom * factor));
        const zoomRatio = this.viewZoom / oldZoom;

        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;

        // Adjust offset so the point under the mouse stays in place
        this.viewOffsetX = mx - (mx - this.viewOffsetX - w / 2) * zoomRatio - w / 2;
        this.viewOffsetY = my - (my - this.viewOffsetY - h / 2) * zoomRatio - h / 2;

        this.draw();
    };
}
