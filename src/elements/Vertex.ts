import * as THREE from 'three';

export default class Triangle {
    public a: THREE.Vector3;
    public b: THREE.Vector3;
    public c: THREE.Vector3;

    constructor(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
        this.a = a;
        this.b = b;
        this.c = c;
    }

    public toArray(): number[] {
        return [
            this.a.x, this.a.y, this.a.z,
            this.b.x, this.b.y, this.b.z,
            this.c.x, this.c.y, this.c.z,
        ];
    }

    public static fromArray(array: number[]): Triangle {
        if (array.length !== 9) {
            throw new Error('Array must have exactly 9 elements');
        }

        return new Triangle(
            new THREE.Vector3(array[0], array[1], array[2]),
            new THREE.Vector3(array[3], array[4], array[5]),
            new THREE.Vector3(array[6], array[7], array[8])
        );
    }
}