import * as THREE from 'three';

interface SurfaceTriangle {
    ax: number;
    ay: number;
    az: number;
    bx: number;
    by: number;
    bz: number;
    cx: number;
    cy: number;
    cz: number;
}

const EPSILON = 1e-7;

/** Cached XZ lookup for the final meshes visible in the editor. */
export default class SurfaceHeightSampler {
    private readonly triangles: SurfaceTriangle[] = [];
    private readonly buckets = new Map<string, number[]>();
    private readonly largeTriangles: number[] = [];
    private cellSize = 1;

    constructor(meshes: readonly THREE.Mesh[]) {
        for (const mesh of meshes) this.collectMesh(mesh);
        this.buildIndex();
    }

    public get isEmpty(): boolean { return this.triangles.length === 0; }

    public sample(x: number, z: number): number | null {
        if (this.isEmpty) return null;
        const candidates = this.buckets.get(this.bucketKey(x, z)) ?? [];
        let highest: number | null = null;
        const visit = (indices: readonly number[]): void => {
            for (const index of indices) {
                const height = this.sampleTriangle(this.triangles[index], x, z);
                if (height !== null && (highest === null || height > highest)) highest = height;
            }
        };
        visit(candidates);
        visit(this.largeTriangles);
        return highest;
    }

    private collectMesh(mesh: THREE.Mesh): void {
        const geometry = mesh.geometry;
        const positions = geometry?.getAttribute('position');
        if (!positions || positions.itemSize < 3) return;
        const indices = geometry.getIndex();
        const triangleCount = Math.floor((indices?.count ?? positions.count) / 3);
        mesh.updateWorldMatrix(true, false);
        const point = new THREE.Vector3();
        const readPoint = (corner: number): THREE.Vector3 => {
            const index = indices ? indices.getX(corner) : corner;
            return point.set(positions.getX(index), positions.getY(index), positions.getZ(index))
                .applyMatrix4(mesh.matrixWorld)
                .clone();
        };

        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
            const offset = triangleIndex * 3;
            const a = readPoint(offset);
            const b = readPoint(offset + 1);
            const c = readPoint(offset + 2);
            const projectedArea = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
            if (Math.abs(projectedArea) <= EPSILON) continue;
            this.triangles.push({
                ax: a.x, ay: a.y, az: a.z,
                bx: b.x, by: b.y, bz: b.z,
                cx: c.x, cy: c.y, cz: c.z,
            });
        }
    }

    private buildIndex(): void {
        if (this.isEmpty) return;
        let minX = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (const triangle of this.triangles) {
            minX = Math.min(minX, triangle.ax, triangle.bx, triangle.cx);
            minZ = Math.min(minZ, triangle.az, triangle.bz, triangle.cz);
            maxX = Math.max(maxX, triangle.ax, triangle.bx, triangle.cx);
            maxZ = Math.max(maxZ, triangle.az, triangle.bz, triangle.cz);
        }
        this.cellSize = Math.max(0.5, Math.max(maxX - minX, maxZ - minZ) / 64);

        for (let index = 0; index < this.triangles.length; index++) {
            const triangle = this.triangles[index];
            const firstX = Math.floor(Math.min(triangle.ax, triangle.bx, triangle.cx) / this.cellSize);
            const lastX = Math.floor(Math.max(triangle.ax, triangle.bx, triangle.cx) / this.cellSize);
            const firstZ = Math.floor(Math.min(triangle.az, triangle.bz, triangle.cz) / this.cellSize);
            const lastZ = Math.floor(Math.max(triangle.az, triangle.bz, triangle.cz) / this.cellSize);
            const coverage = (lastX - firstX + 1) * (lastZ - firstZ + 1);
            if (coverage > 4096) {
                this.largeTriangles.push(index);
                continue;
            }
            for (let cellX = firstX; cellX <= lastX; cellX++) {
                for (let cellZ = firstZ; cellZ <= lastZ; cellZ++) {
                    const key = `${cellX}:${cellZ}`;
                    const bucket = this.buckets.get(key);
                    if (bucket) bucket.push(index);
                    else this.buckets.set(key, [index]);
                }
            }
        }
    }

    private bucketKey(x: number, z: number): string {
        return `${Math.floor(x / this.cellSize)}:${Math.floor(z / this.cellSize)}`;
    }

    private sampleTriangle(triangle: SurfaceTriangle, x: number, z: number): number | null {
        const denominator = (triangle.bz - triangle.cz) * (triangle.ax - triangle.cx)
            + (triangle.cx - triangle.bx) * (triangle.az - triangle.cz);
        if (Math.abs(denominator) <= EPSILON) return null;
        const u = ((triangle.bz - triangle.cz) * (x - triangle.cx)
            + (triangle.cx - triangle.bx) * (z - triangle.cz)) / denominator;
        const v = ((triangle.cz - triangle.az) * (x - triangle.cx)
            + (triangle.ax - triangle.cx) * (z - triangle.cz)) / denominator;
        const w = 1 - u - v;
        if (u < -EPSILON || v < -EPSILON || w < -EPSILON) return null;
        return triangle.ay * u + triangle.by * v + triangle.cy * w;
    }
}
