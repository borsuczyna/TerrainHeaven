export const TERRAIN_TEXTURE_LAYER_COUNT = 4;
export const DEFAULT_TERRAIN_CONTROL_RESOLUTION = 128;

export type TextureBrushShape =
    | 'soft-round' | 'medium-round' | 'hard-round'
    | 'soft-square' | 'hard-square'
    | 'noise' | 'speckle' | 'ridge';

export interface TexturePaintStroke {
    u: number;
    v: number;
    radiusU: number;
    radiusV: number;
    layer: number;
    opacity: number;
    hardness: number;
    rotation: number;
    shape: TextureBrushShape;
    seed?: number;
}

/** Compact RGBA splat map. The four bytes at every texel always sum to 255. */
export default class TerrainTexturePaint {
    public readonly data: Uint8Array;

    constructor(public readonly resolution = DEFAULT_TERRAIN_CONTROL_RESOLUTION, data?: Uint8Array) {
        if (!Number.isInteger(resolution) || resolution < 16 || resolution > 512) {
            throw new Error('Terrain control-map resolution must be an integer from 16 to 512.');
        }
        const length = resolution * resolution * TERRAIN_TEXTURE_LAYER_COUNT;
        this.data = data?.length === length ? new Uint8Array(data) : new Uint8Array(length);
        if (!data) {
            for (let offset = 0; offset < length; offset += 4) this.data[offset] = 255;
        }
    }

    public paint(stroke: TexturePaintStroke): boolean {
        const layer = Math.max(0, Math.min(3, Math.round(stroke.layer)));
        const radiusU = Math.max(0.5 / this.resolution, stroke.radiusU);
        const radiusV = Math.max(0.5 / this.resolution, stroke.radiusV);
        const opacity = clamp01(stroke.opacity);
        const hardness = clamp01(stroke.hardness);
        const cos = Math.cos(stroke.rotation);
        const sin = Math.sin(stroke.rotation);
        const minX = Math.max(0, Math.floor((stroke.u - radiusU) * this.resolution));
        const maxX = Math.min(this.resolution - 1, Math.ceil((stroke.u + radiusU) * this.resolution));
        const minY = Math.max(0, Math.floor((stroke.v - radiusV) * this.resolution));
        const maxY = Math.min(this.resolution - 1, Math.ceil((stroke.v + radiusV) * this.resolution));
        let changed = false;

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const du = ((x + 0.5) / this.resolution - stroke.u) / radiusU;
                const dv = ((y + 0.5) / this.resolution - stroke.v) / radiusV;
                const rx = du * cos - dv * sin;
                const ry = du * sin + dv * cos;
                const isSquare = stroke.shape === 'soft-square' || stroke.shape === 'hard-square';
                const distance = isSquare ? Math.max(Math.abs(rx), Math.abs(ry)) : Math.hypot(rx, ry);
                if (distance > 1) continue;

                const effectiveHardness = stroke.shape === 'medium-round' ? Math.max(0.45, hardness)
                    : stroke.shape === 'hard-round' || stroke.shape === 'hard-square' ? 0.98
                    : hardness;
                let falloff = 1 - smoothstep(effectiveHardness, 1, distance);
                if (stroke.shape === 'noise') {
                    falloff *= 0.35 + hashNoise(x, y, stroke.seed ?? 0) * 0.65;
                } else if (stroke.shape === 'speckle') {
                    falloff *= hashNoise(x, y, stroke.seed ?? 0) > 0.58 ? 1 : 0.08;
                } else if (stroke.shape === 'ridge') {
                    const noise = hashNoise(x, y, stroke.seed ?? 0);
                    falloff *= 0.18 + Math.abs(Math.sin((rx + ry) * 12 + noise * 2.5)) * 0.82;
                }
                const blend = clamp01(opacity * falloff);
                if (blend <= 0.0001) continue;

                const offset = (y * this.resolution + x) * 4;
                const previous = this.data[layer + offset];
                const target = Math.round(previous + (255 - previous) * blend);
                if (target === previous) continue;
                const oldOtherTotal = 255 - previous;
                const newOtherTotal = 255 - target;
                for (let channel = 0; channel < 4; channel++) {
                    if (channel === layer) continue;
                    this.data[offset + channel] = oldOtherTotal > 0
                        ? Math.round(this.data[offset + channel] * newOtherTotal / oldOtherTotal)
                        : 0;
                }
                this.data[offset + layer] = target;
                this.fixSum(offset, layer);
                changed = true;
            }
        }
        return changed;
    }

    public clear(layer = 0): void {
        const channel = Math.max(0, Math.min(3, Math.round(layer)));
        this.data.fill(0);
        for (let offset = 0; offset < this.data.length; offset += 4) this.data[offset + channel] = 255;
    }

    /** Run-length encoding is excellent for mostly uniform painted maps and stays JSON-safe. */
    public encodeRle(): string {
        const out: number[] = [];
        for (let offset = 0; offset < this.data.length;) {
            let count = 1;
            while (count < 255 && offset + count * 4 < this.data.length
                && rgbaEqual(this.data, offset, offset + count * 4)) count++;
            out.push(count, this.data[offset], this.data[offset + 1], this.data[offset + 2], this.data[offset + 3]);
            offset += count * 4;
        }
        let binary = '';
        for (const byte of out) binary += String.fromCharCode(byte);
        return btoa(binary);
    }

    public static decodeRle(resolution: number, encoded: string): TerrainTexturePaint {
        const output = new Uint8Array(resolution * resolution * 4);
        const binary = atob(encoded);
        let outputOffset = 0;
        for (let index = 0; index + 4 < binary.length && outputOffset < output.length; index += 5) {
            const count = binary.charCodeAt(index);
            const rgba = [1, 2, 3, 4].map((delta) => binary.charCodeAt(index + delta));
            for (let repeat = 0; repeat < count && outputOffset < output.length; repeat++) {
                output.set(rgba, outputOffset);
                outputOffset += 4;
            }
        }
        if (outputOffset !== output.length) throw new Error('Invalid terrain control-map data.');
        return new TerrainTexturePaint(resolution, output);
    }

    private fixSum(offset: number, preferredChannel: number): void {
        let sum = 0;
        for (let channel = 0; channel < 4; channel++) sum += this.data[offset + channel];
        const corrected = this.data[offset + preferredChannel] + 255 - sum;
        this.data[offset + preferredChannel] = Math.max(0, Math.min(255, corrected));
    }
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function smoothstep(a: number, b: number, value: number): number {
    if (a >= b) return value >= b ? 1 : 0;
    const t = clamp01((value - a) / (b - a));
    return t * t * (3 - 2 * t);
}
function rgbaEqual(data: Uint8Array, a: number, b: number): boolean {
    return data[a] === data[b] && data[a + 1] === data[b + 1]
        && data[a + 2] === data[b + 2] && data[a + 3] === data[b + 3];
}
function hashNoise(x: number, y: number, seed: number): number {
    let value = Math.imul(x ^ seed, 374761393) + Math.imul(y + seed, 668265263);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}
