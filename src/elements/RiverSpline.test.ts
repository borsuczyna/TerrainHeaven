import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RiverSpline from './RiverSpline';
import TerrainMesher from '../terrain/TerrainMesher';

const expectFiniteGeometry = (river: RiverSpline): void => {
    const positions = river.mesh.geometry.getAttribute('position');
    expect(positions.count).toBeGreaterThan(0);
    for (let index = 0; index < positions.count; index++) {
        expect(Number.isFinite(positions.getX(index))).toBe(true);
        expect(Number.isFinite(positions.getY(index))).toBe(true);
        expect(Number.isFinite(positions.getZ(index))).toBe(true);
    }
};

describe('RiverSpline', () => {
    it('keeps terrain sealed, sculpts the channel and renders a water overlay', () => {
        const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0));
        river.update();

        expect(river.cutsTerrainSurface()).toBe(false);
        const material = (Array.isArray(river.mesh.material) ? river.mesh.material[0] : river.mesh.material) as THREE.MeshStandardMaterial;
        expect(material.transparent).toBe(true);
        expect(material.depthWrite).toBe(false);
        expectFiniteGeometry(river);

        const samples = river.getSampledTerrainPoints(0);
        expect(samples.length).toBeGreaterThan(6);
        const bedSamples = samples.filter((sample) => !sample.profileOnly);
        const profileSamples = samples.filter((sample) => sample.profileOnly);
        expect(bedSamples.every((sample) => sample.position.y < -0.3)).toBe(true);
        expect(profileSamples.length).toBeGreaterThan(0);
        expect(profileSamples.some((sample) => Math.abs(sample.position.y) < 1e-5)).toBe(true);
        const terrain = new TerrainMesher().build({
            center: new THREE.Vector3(0, 3, 0),
            width: 20,
            length: 20,
            cutAreas: [],
            cutPoints: samples,
            settings: {
                meshDetail: 2,
                triangleLimit: 1200,
                smoothingEnabled: true,
                smoothingRadius: 4,
                maxSlopeDegrees: 35,
            },
        });
        expect(terrain.length).toBeGreaterThan(2);
        const terrainArea = terrain.reduce((sum, triangle) => sum + Math.abs(
            (triangle.b.x - triangle.a.x) * (triangle.c.z - triangle.a.z)
            - (triangle.b.z - triangle.a.z) * (triangle.c.x - triangle.a.x),
        ) * 0.5, 0);
        expect(terrainArea).toBeCloseTo(400, 3);
        expect(terrain.flatMap((triangle) => [triangle.a, triangle.b, triangle.c])
            .some((point) => point.y < -0.3)).toBe(true);
    });

    it('uses Bank Slope as the actual bank angle', () => {
        const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0));
        river.bankSlope = 20;
        const shallow = river.getSampledTerrainPoints(0);
        river.bankSlope = 75;
        const steep = river.getSampledTerrainPoints(0);

        expect(shallow[0].position.y).toBeCloseTo(steep[0].position.y, 8);
        expect(shallow[0].radius).toBeGreaterThan(steep[0].radius * 5);
        expect(shallow[0].maxSlopeDegrees).toBe(20);
        expect(steep[0].maxSlopeDegrees).toBe(75);
    });

    it('rounds and refines the bank profile with Slope Smoothing', () => {
        const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0));
        river.bankSlope = 45;
        river.bankSmoothing = 0;
        const linear = river.getSampledTerrainPoints(0);
        river.bankSmoothing = 1;
        const smooth = river.getSampledTerrainPoints(0);

        const linearBed = linear.find((sample) => !sample.profileOnly)!;
        const smoothBed = smooth.find((sample) => !sample.profileOnly)!;
        const smoothProfile = smooth.filter((sample) => sample.profileOnly);
        expect(smoothBed.radius).toBeCloseTo(linearBed.radius * 1.5, 8);
        expect(smoothBed.slopeSmoothing).toBe(1);
        expect(smoothProfile.length).toBeGreaterThan(0);
        expect(new Set(smoothProfile.map((sample) => sample.position.y.toFixed(5))).size).toBeGreaterThan(2);

        const restored = RiverSpline.deserialize(river.serialize(1));
        expect(restored.bankSmoothing).toBe(1);
    });

    it('adds deterministic bank irregularity and locally remeshes at higher detail', () => {
        const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        river.width = 4;
        river.bankSlope = 45;
        river.bankSmoothing = 0.65;
        river.detailLevel = 0.1;
        river.irregularityLevel = 0;
        const regularLowDetail = river.getSampledTerrainPoints(0);

        river.detailLevel = 4;
        river.irregularityLevel = 1;
        const irregularHighDetail = river.getSampledTerrainPoints(0);
        const repeated = river.getSampledTerrainPoints(0);

        expect(irregularHighDetail.length).toBeGreaterThan(regularLowDetail.length * 10);
        expect(repeated.map((sample) => sample.position.toArray()))
            .toEqual(irregularHighDetail.map((sample) => sample.position.toArray()));

        const outerBankWidths = irregularHighDetail
            .filter((sample) => sample.profileOnly && Math.abs(sample.position.y) < 1e-6)
            .map((sample) => Math.abs(sample.position.z).toFixed(4));
        expect(new Set(outerBankWidths).size).toBeGreaterThan(4);

        const restored = RiverSpline.deserialize(river.serialize(1));
        expect(restored.irregularityLevel).toBe(1);
        expect(restored.detailLevel).toBe(4);
    });

    it('accepts fractional detail below the baseline and persists it', () => {
        const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        river.detailLevel = 0.1;
        const sparse = river.getSampledTerrainPoints(0);
        river.detailLevel = 1;
        const baseline = river.getSampledTerrainPoints(0);

        expect(sparse.length).toBeLessThan(baseline.length / 2);
        river.detailLevel = 0.3;
        expect(RiverSpline.deserialize(river.serialize(1)).detailLevel).toBeCloseTo(0.3, 8);
    });

    it('always adds Divisions to both water geometry and terrain remeshing', () => {
        const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        river.detailLevel = 1;
        river.update();
        const waterWithoutDivisions = river.mesh.geometry.getAttribute('position').count;
        const terrainWithoutDivisions = river.getSampledTerrainPoints(0).length;

        river.divisions = 5;
        const waterWithDivisions = river.mesh.geometry.getAttribute('position').count;
        const terrainWithDivisions = river.getSampledTerrainPoints(0).length;

        expect(waterWithDivisions).toBeGreaterThan(waterWithoutDivisions);
        expect(terrainWithDivisions).toBeGreaterThan(terrainWithoutDivisions);
    });

    it('keeps both meshes valid when two river paths are connected', () => {
        const first = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0));
        const second = new RiverSpline(new THREE.Vector3(5, 0, 0), new THREE.Vector3(9, 0, 4));
        first.divisions = 4;
        second.divisions = 4;

        expect(second.connect(0, first, 1)).toBe(true);
        expectFiniteGeometry(first);
        expectFiniteGeometry(second);
        expect(first.connections.get(1)?.element).toBe(second);
        expect(second.connections.get(0)?.element).toBe(first);
    });

    describe('Irregularity Level', () => {
        // Bed-row terrain samples sit exactly on the water's own edge, so the two must
        // move together at every Irregularity level - a mismatch would open a gap or an
        // overlap right at the shoreline. Samples are spaced along the curve rather than
        // at round x values, so pick whatever bed row actually landed nearest x.
        const crossSectionSpan = (river: RiverSpline, x: number): number => {
            const bedSamples = river.getSampledTerrainPoints(0).filter((sample) => !sample.profileOnly);
            const nearestX = bedSamples
                .map((sample) => sample.position.x)
                .reduce((best, value) => (Math.abs(value - x) < Math.abs(best - x) ? value : best));
            const zs = bedSamples
                .filter((sample) => Math.abs(sample.position.x - nearestX) < 1e-6)
                .map((sample) => sample.position.z);
            return Math.max(...zs) - Math.min(...zs);
        };

        it('accepts values above 1 and keeps the water edge matched to the terrain bed edge', () => {
            for (const level of [0, 1, 2, 3]) {
                const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(40, 0, 0));
                river.width = 4;
                river.divisions = 3;
                river.detailLevel = 2;
                river.irregularityLevel = level;
                river.update();
                expect(river.irregularityLevel).toBe(level);

                // Resolve the target x once, from the bed samples, and reuse it for the
                // water buffer too - picking "nearest to 20" independently from each list
                // can split a near-tie two different ways once the water buffer's Float32
                // storage rounds a value that was equidistant at full precision.
                const bedSamples = river.getSampledTerrainPoints(0).filter((sample) => !sample.profileOnly);
                const nearestX = bedSamples
                    .map((sample) => sample.position.x)
                    .reduce((best, value) => (Math.abs(value - 20) < Math.abs(best - 20) ? value : best));
                const position = river.mesh.geometry.getAttribute('position');
                const midZs: number[] = [];
                for (let i = 0; i < position.count; i++) {
                    if (Math.abs(position.getX(i) - nearestX) < 1e-3) midZs.push(position.getZ(i));
                }
                const waterSpan = Math.max(...midZs) - Math.min(...midZs);
                expect(Math.abs(waterSpan - crossSectionSpan(river, 20))).toBeLessThan(0.05);
            }
        });

        it('makes higher levels noticeably more jagged, not just uniformly wider', () => {
            const edgeVariance = (level: number): number => {
                const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(60, 0, 0));
                river.width = 4;
                river.divisions = 4;
                river.detailLevel = 2;
                river.irregularityLevel = level;
                const spans = [10, 20, 30, 40, 50].map((x) => crossSectionSpan(river, x));
                const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
                return spans.reduce((a, b) => a + (b - mean) ** 2, 0) / spans.length;
            };
            expect(edgeVariance(2.5)).toBeGreaterThan(edgeVariance(0.3) * 4);
        });

        it('never lets the channel pinch shut, even at the maximum level', () => {
            const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(40, 0, 0));
            river.width = 4;
            river.divisions = 3;
            river.irregularityLevel = 3;
            const spans = [10, 15, 20, 25, 30].map((x) => crossSectionSpan(river, x));
            expect(Math.min(...spans)).toBeGreaterThan(0.3);
        });
    });
});
