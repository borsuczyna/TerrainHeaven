import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { container } from 'tsyringe';
import SceneManager from '../editor/SceneManager';
import Terrain from '../elements/Terrain';
import TerrainCutSpline from '../elements/TerrainCutSpline';
import RiverSpline from '../elements/RiverSpline';
import TerrainGroupMesher from './TerrainGroupMesher';

interface Vertex { x: number; y: number; z: number }

const triangles = (terrain: Terrain): [Vertex, Vertex, Vertex][] => {
    const position = terrain.mesh.geometry.getAttribute('position');
    const points: Vertex[] = [];
    for (let index = 0; index < position.count; index++) {
        points.push({ x: position.getX(index), y: position.getY(index), z: position.getZ(index) });
    }
    const result: [Vertex, Vertex, Vertex][] = [];
    for (let index = 0; index + 2 < points.length; index += 3) {
        result.push([points[index], points[index + 1], points[index + 2]]);
    }
    return result;
};

// The steepest edge anywhere in a tile. A surface that honours Max Slope must not
// contain an edge appreciably steeper than tan(maxSlope), no matter how many cut points
// pile up on top of each other.
const steepestSlope = (terrain: Terrain): { slope: number; where: string } => {
    let worst = { slope: 0, where: 'none' };
    for (const tri of triangles(terrain)) {
        for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
            const run = Math.hypot(b.x - a.x, b.z - a.z);
            if (run < 1e-6) continue;
            const slope = Math.abs(b.y - a.y) / run;
            if (slope > worst.slope) {
                worst = { slope, where: `(${a.x.toFixed(2)},${a.z.toFixed(2)}) -> (${b.x.toFixed(2)},${b.z.toFixed(2)})` };
            }
        }
    }
    return worst;
};

const area = (terrain: Terrain): number => triangles(terrain).reduce((sum, [a, b, c]) => (
    sum + Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2
), 0);

const freshScene = (): SceneManager => {
    const scene = container.resolve(SceneManager);
    for (const element of [...scene.getElements()]) scene.remove(element);
    return scene;
};

// The spline saved in the report that this suite exists for: it runs across the shared
// edge of two tiles, four units wide, four units deep.
const crossingSpline = (): TerrainCutSpline => {
    const spline = new TerrainCutSpline(
        new THREE.Vector3(2.465868690316727, -4.235237081011675, -19.754201782271124),
        new THREE.Vector3(2.0766671505637273, -4.2352370810116735, -9.470413082974028),
    );
    spline.distance = 4;
    spline.divisions = 5;
    return spline;
};

describe('TerrainGroupMesher', () => {
    it('keeps a cut spline crossing a shared edge within Max Slope', () => {
        const scene = freshScene();
        const near = new Terrain(new THREE.Vector3(0, 0, 0), 30, 30);
        const far = new Terrain(new THREE.Vector3(0, 0, -30), 30, 30);
        scene.add(near);
        scene.add(far);
        scene.add(crossingSpline());
        near.update();
        far.update();

        const limit = Math.tan(THREE.MathUtils.degToRad(near.maxSlopeDegrees + 2));
        expect(steepestSlope(near).slope).toBeLessThan(limit);
        expect(steepestSlope(far).slope).toBeLessThan(limit);
    });

    it('gives the pair of tiles the same surface a single tile would get', () => {
        const scene = freshScene();
        const near = new Terrain(new THREE.Vector3(0, 0, 0), 30, 30);
        const far = new Terrain(new THREE.Vector3(0, 0, -30), 30, 30);
        scene.add(near);
        scene.add(far);
        scene.add(crossingSpline());
        near.update();
        far.update();
        const paired = Math.max(steepestSlope(near).slope, steepestSlope(far).slope);

        freshScene();
        const single = new Terrain(new THREE.Vector3(0, 0, -15), 30, 60);
        scene.add(single);
        scene.add(crossingSpline());
        single.update();

        // The shared edge must not make the surface any steeper than it would be if the
        // same ground were one tile. It used to be nearly twice as steep there.
        expect(paired).toBeLessThan(steepestSlope(single).slope * 1.15 + 0.05);
    });

    it('hands every part of the surface to exactly one tile', () => {
        const scene = freshScene();
        const tiles = [
            new Terrain(new THREE.Vector3(-10, 0, -10), 20, 20),
            new Terrain(new THREE.Vector3(10, 0, -10), 20, 20),
            new Terrain(new THREE.Vector3(-10, 0, 10), 20, 20),
            new Terrain(new THREE.Vector3(10, 0, 10), 20, 20),
        ];
        for (const tile of tiles) scene.add(tile);
        for (const tile of tiles) tile.update();

        // Nothing lost and nothing duplicated by the split.
        const total = tiles.reduce((sum, tile) => sum + area(tile), 0);
        expect(total).toBeCloseTo(4 * 20 * 20, 3);

        // No triangle may straddle a tile border, or it would be drawn with one tile's
        // texture while lying under another.
        for (const tile of tiles) {
            const bounds = tile.getBounds();
            for (const tri of triangles(tile)) {
                for (const vertex of tri) {
                    expect(vertex.x).toBeGreaterThanOrEqual(bounds.minX - 1e-4);
                    expect(vertex.x).toBeLessThanOrEqual(bounds.maxX + 1e-4);
                    expect(vertex.z).toBeGreaterThanOrEqual(bounds.minZ - 1e-4);
                    expect(vertex.z).toBeLessThanOrEqual(bounds.maxZ + 1e-4);
                }
            }
        }
    });

    it('does not depend on the order tiles were added to the scene', () => {
        const build = (reversed: boolean): string => {
            const scene = freshScene();
            const near = new Terrain(new THREE.Vector3(0, 0, 0), 30, 30);
            const far = new Terrain(new THREE.Vector3(0, 0, -30), 30, 30);
            near.meshDetail = 4;
            far.meshDetail = 2;
            for (const tile of reversed ? [far, near] : [near, far]) scene.add(tile);
            scene.add(crossingSpline());
            near.update();
            far.update();
            return [near, far]
                .map((tile) => triangles(tile)
                    .flat()
                    .map((vertex) => `${vertex.x.toFixed(4)},${vertex.y.toFixed(4)},${vertex.z.toFixed(4)}`)
                    .sort()
                    .join(';'))
                .join('#');
        };
        expect(build(false)).toEqual(build(true));
    });

    describe('buildLODSurface', () => {
        it('thins terrain-shaping cut points along with the mesh, instead of forcing full density into a shrunk budget', () => {
            // A dense river (small Divisions/Detail Level target spacing relative to
            // the tile) used to keep contributing just as many cut points at every LOD,
            // so a heavily reduced triangleLimit had to cram them in anyway - producing
            // a chaotic tangle of slivers rather than a clean, simplified surface.
            const scene = freshScene();
            const terrain = new Terrain(new THREE.Vector3(0, 0, 0), 40, 40);
            terrain.meshDetail = 2;
            terrain.triangleLimit = 1500;
            scene.add(terrain);
            const river = new RiverSpline(new THREE.Vector3(-18, 0, -3), new THREE.Vector3(18, 0, 3));
            river.detailLevel = 2;
            river.divisions = 4;
            scene.add(river);
            terrain.update();

            const mesher = container.resolve(TerrainGroupMesher);
            const counts = [0, 1, 2, 3].map((lod) => mesher.buildLODSurface(terrain, lod).length);
            // Strictly decreasing - each LOD level is a real simplification of the last,
            // never a plateau caused by leftover full-density constraints.
            for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThan(counts[i - 1]);
        });

        it('keeps every LOD level free of edges far steeper than the river bank actually calls for', () => {
            const scene = freshScene();
            const terrain = new Terrain(new THREE.Vector3(0, 0, 0), 40, 40);
            scene.add(terrain);
            const river = new RiverSpline(new THREE.Vector3(-18, 0, -3), new THREE.Vector3(18, 0, 3));
            river.detailLevel = 2;
            river.divisions = 4;
            scene.add(river);
            terrain.update();

            const mesher = container.resolve(TerrainGroupMesher);
            // River bankSlope defaults to 70 degrees, not the terrain's 35 Max Slope -
            // the bank is *supposed* to get that steep. A generous margin above 70 still
            // catches a genuine blow-up without being a hair-trigger test.
            const limit = Math.tan(THREE.MathUtils.degToRad(85));
            for (const lod of [0, 1, 2, 3]) {
                const worst = Math.max(...mesher.buildLODSurface(terrain, lod).flatMap((tri) => (
                    [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]].map(([a, b]) => {
                        const run = Math.hypot(b.x - a.x, b.z - a.z);
                        return run < 1e-6 ? 0 : Math.abs(b.y - a.y) / run;
                    })
                )));
                expect(worst).toBeLessThan(limit);
            }
        });
    });
});
