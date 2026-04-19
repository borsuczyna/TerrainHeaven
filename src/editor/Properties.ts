import * as THREE from 'three';

export interface PropertyVector3 {
    type: 'vector3';
    label: string;
    get: () => THREE.Vector3;
    set: (v: THREE.Vector3) => void;
}

export interface PropertyNumber {
    type: 'number';
    label: string;
    get: () => number;
    set: (v: number) => void;
    min?: number;
    max?: number;
    step?: number;
}

export type Property = PropertyVector3 | PropertyNumber;

export interface PropertyButton {
    type: 'button';
    label: string;
    onClick: () => void;
}

export type SectionItem = Property | PropertyButton;

export interface PropertySection {
    label: string;
    properties: SectionItem[];
}

export interface PropertyDefinition {
    title: string;
    icon: string;
    sections: PropertySection[];
}
