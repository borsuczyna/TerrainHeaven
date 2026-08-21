import { describe, expect, it } from 'vitest';
import { buildMtl, buildObj, type ObjGroup, type ObjMaterial } from './ObjWriter';

const square = (materialName: string): ObjGroup => ({
    name: 'road',
    materialName,
    // Two triangles, 3 unique vertices each - matches how this app always builds
    // geometry (no shared/indexed vertices).
    positions: [
        0, 0, 0, 1, 0, 0, 1, 0, 1,
        0, 0, 0, 1, 0, 1, 0, 0, 1,
    ],
    uvs: [
        0, 0, 1, 0, 1, 1,
        0, 0, 1, 1, 0, 1,
    ],
});

describe('ObjWriter', () => {
    it('emits a v/vt/vn triple per vertex and one f line per triangle, unindexed', () => {
        const obj = buildObj('road_lod0.mtl', 'road_lod0', [square('road_lod0_road')]);
        const lines = obj.split('\n').filter((line) => line.length > 0);

        expect(lines[0]).toBe('mtllib road_lod0.mtl');
        expect(lines[1]).toBe('o road_lod0');
        expect(lines[2]).toBe('g road');
        expect(lines[3]).toBe('usemtl road_lod0_road');

        const vLines = lines.filter((line) => line.startsWith('v '));
        const vtLines = lines.filter((line) => line.startsWith('vt '));
        const vnLines = lines.filter((line) => line.startsWith('vn '));
        const fLines = lines.filter((line) => line.startsWith('f '));
        expect(vLines).toHaveLength(6);
        expect(vtLines).toHaveLength(6);
        expect(vnLines).toHaveLength(6);
        expect(fLines).toHaveLength(2);
        expect(fLines[0]).toBe('f 1/1/1 2/2/2 3/3/3');
        expect(fLines[1]).toBe('f 4/4/4 5/5/5 6/6/6');
    });

    it('keeps a running vertex count across multiple groups instead of resetting per group', () => {
        const groupA: ObjGroup = { ...square('mat_a'), name: 'road' };
        const groupB: ObjGroup = { ...square('mat_b'), name: 'sidewalk' };
        const obj = buildObj('mixed.mtl', 'mixed', [groupA, groupB]);
        const fLines = obj.split('\n').filter((line) => line.startsWith('f '));

        expect(fLines).toEqual([
            'f 1/1/1 2/2/2 3/3/3',
            'f 4/4/4 5/5/5 6/6/6',
            // Second group's faces continue from vertex 7, not restart at 1 - an OBJ
            // parser tracks one running vertex list for the whole file.
            'f 7/7/7 8/8/8 9/9/9',
            'f 10/10/10 11/11/11 12/12/12',
        ]);
    });

    describe('auto-smooth normals', () => {
        it('gives every vertex the same normal across a flat, coplanar surface', () => {
            const obj = buildObj('flat.mtl', 'flat', [square('flat_mat')]);
            const vnLines = obj.split('\n').filter((line) => line.startsWith('vn '));
            expect(vnLines).toHaveLength(6);
            // The fixture is a quad flat in the XZ plane - both triangles share one
            // face normal, so smoothing changes nothing: every vertex still points the
            // same way.
            for (const line of vnLines) expect(line).toBe(vnLines[0]);
            const [, x, y, z] = vnLines[0].split(' ').map(Number.parseFloat) as [undefined, number, number, number];
            expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
            expect(Math.abs(y)).toBeCloseTo(1, 5);
        });

        it('keeps a sharp corner crisp instead of averaging across it', () => {
            // Two quads meeting at a 90 degree corner (well past the 30 degree
            // threshold) - a floor and a wall sharing the edge x=1. Each side's own
            // vertices must keep that side's own normal, not some blended value.
            const floor: ObjGroup = {
                name: 'floor',
                materialName: 'floor_mat',
                positions: [
                    0, 0, 0, 1, 0, 0, 1, 0, 1,
                    0, 0, 0, 1, 0, 1, 0, 0, 1,
                ],
                uvs: [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1],
            };
            const wall: ObjGroup = {
                name: 'wall',
                materialName: 'wall_mat',
                positions: [
                    1, 0, 0, 1, 1, 0, 1, 1, 1,
                    1, 0, 0, 1, 1, 1, 1, 0, 1,
                ],
                uvs: [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1],
            };
            const obj = buildObj('corner.mtl', 'corner', [floor, wall]);
            const vnLines = obj.split('\n').filter((line) => line.startsWith('vn ')).map((line) => (
                line.split(' ').slice(1).map(Number.parseFloat) as [number, number, number]
            ));

            const dot = (a: [number, number, number], b: [number, number, number]): number => (
                a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
            );
            const floorNormal = vnLines[0];
            const wallNormal = vnLines[6];
            // Genuinely different directions (not blended toward each other) - a flat
            // floor normal and a vertical wall normal are perpendicular.
            expect(Math.abs(dot(floorNormal, wallNormal))).toBeLessThan(0.1);
            for (const n of vnLines.slice(0, 6)) expect(dot(n, floorNormal)).toBeGreaterThan(0.99);
            for (const n of vnLines.slice(6)) expect(dot(n, wallNormal)).toBeGreaterThan(0.99);
        });
    });

    it('skips a group with no triangles rather than emitting an empty g/usemtl pair', () => {
        const empty: ObjGroup = { name: 'bridgePillars', materialName: 'mat_empty', positions: [], uvs: [] };
        const obj = buildObj('road_lod0.mtl', 'road_lod0', [square('mat_road'), empty]);
        expect(obj).not.toContain('bridgePillars');
    });

    it('writes one newmtl block per material with a relative map_Kd when textured', () => {
        const materials: ObjMaterial[] = [
            { name: 'road_lod0_road', textureRelativePath: '../Textures/road.png' },
            { name: 'road_lod0_sidewalk', textureRelativePath: null },
        ];
        const mtl = buildMtl(materials);
        expect(mtl).toContain('newmtl road_lod0_road');
        expect(mtl).toContain('map_Kd ../Textures/road.png');
        expect(mtl).toContain('newmtl road_lod0_sidewalk');

        const sidewalkBlock = mtl.split('newmtl road_lod0_sidewalk')[1];
        expect(sidewalkBlock).not.toContain('map_Kd');
    });

    it('sanitizes group/material names so they stay valid OBJ/MTL identifiers', () => {
        const weird = square('weird mat/name');
        weird.name = 'weird group name!';
        const obj = buildObj('x.mtl', 'x', [weird]);
        expect(obj).toContain('g weird_group_name');
        expect(obj).toContain('usemtl weird_matname');
    });
});
