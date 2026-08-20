declare module 'poly2tri/src/sweepcontext.js' {
    interface Poly2TriPoint {
        x: number;
        y: number;
    }

    interface Poly2TriTriangle {
        getPoints(): [Poly2TriPoint, Poly2TriPoint, Poly2TriPoint];
    }

    interface SweepContextOptions {
        cloneArrays?: boolean;
    }

    export default class SweepContext {
        constructor(contour: Poly2TriPoint[], options?: SweepContextOptions);
        addHole(polyline: Poly2TriPoint[]): this;
        addPoints(points: Poly2TriPoint[]): this;
        triangulate(): this;
        getTriangles(): Poly2TriTriangle[];
    }
}
