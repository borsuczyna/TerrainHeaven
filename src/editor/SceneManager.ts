import * as THREE from 'three';
import type WorldElement from '../elements/WorldElement';
import { singleton } from 'tsyringe';

@singleton()
export default class SceneManager {
    public readonly instance: THREE.Scene = new THREE.Scene();
    private elements: WorldElement[] = [];
    constructor() {
        this.instance = new THREE.Scene();
        this.setupGrid();
        this.setupLighting();
    }

    private setupGrid(): void {
        const gridHelper = new THREE.GridHelper(100, 100, 0x888888, 0x555555);
        (gridHelper.material as THREE.Material).transparent = true;
        (gridHelper.material as THREE.Material).opacity = 0.2;
        this.instance.add(gridHelper);
    }

    private setupLighting(): void {
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.instance.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(10, 20, 10);
        this.instance.add(directionalLight);
    }

    public add(object: WorldElement): void {
        this.elements.push(object);
        this.instance.add(object.mesh);
        this.update();
    }

    public getElements(): WorldElement[] {
        return this.elements;
    }

    public clearElements(): void {
        for (const el of this.elements) {
            this.instance.remove(el.mesh);
        }
        this.elements = [];
    }

    public addMesh(mesh: THREE.Mesh): void {
        this.instance.add(mesh);
    }

    public update(): void {
        this.elements.forEach(element => element.update());
    }
}