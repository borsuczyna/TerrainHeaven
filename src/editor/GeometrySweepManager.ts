import * as THREE from 'three';
import { singleton } from 'tsyringe';
import type { GeometryGroup } from '../elements/WorldElement';
import Triangle from '../elements/Vertex';

export interface GeometryLineVertex {
    lateral: number;
    height: number;
    u: number;
    v: number;
}

export interface GeometryLineSegment<TGroup extends string = string> {
    group: TGroup;
    start: GeometryLineVertex;
    end: GeometryLineVertex;
}

export interface GeometryLineSection<TGroup extends string = string> {
    origin: THREE.Vector3;
    right: THREE.Vector3;
    segments: GeometryLineSegment<TGroup>[];
}

@singleton()
export default class GeometrySweepManager {
    public sweepSections<TGroup extends string = string>(
        sections: GeometryLineSection<TGroup>[],
    ): GeometryGroup[] {
        const trianglesByGroup = new Map<string, Triangle[]>();
        const groupOrder: string[] = [];

        const getOrCreateGroup = (name: string): Triangle[] => {
            const existing = trianglesByGroup.get(name);
            if (existing) return existing;
            const created: Triangle[] = [];
            trianglesByGroup.set(name, created);
            groupOrder.push(name);
            return created;
        };

        for (let i = 0; i < sections.length - 1; i++) {
            const currSection = sections[i];
            const nextSection = sections[i + 1];
            const segmentCount = Math.min(currSection.segments.length, nextSection.segments.length);

            for (let s = 0; s < segmentCount; s++) {
                const currSegment = currSection.segments[s];
                const nextSegment = nextSection.segments[s];
                if (currSegment.group !== nextSegment.group) continue;

                const bl = this.placeGeometryLineVertex(currSection.origin, currSection.right, currSegment.start);
                const br = this.placeGeometryLineVertex(currSection.origin, currSection.right, currSegment.end);
                const tl = this.placeGeometryLineVertex(nextSection.origin, nextSection.right, nextSegment.start);
                const tr = this.placeGeometryLineVertex(nextSection.origin, nextSection.right, nextSegment.end);

                const triangles = getOrCreateGroup(String(currSegment.group));
                triangles.push(new Triangle(bl, br, tr,
                    new THREE.Vector2(currSegment.start.u, currSegment.start.v),
                    new THREE.Vector2(currSegment.end.u, currSegment.end.v),
                    new THREE.Vector2(nextSegment.end.u, nextSegment.end.v),
                ));
                triangles.push(new Triangle(bl, tr, tl,
                    new THREE.Vector2(currSegment.start.u, currSegment.start.v),
                    new THREE.Vector2(nextSegment.end.u, nextSegment.end.v),
                    new THREE.Vector2(nextSegment.start.u, nextSegment.start.v),
                ));
            }
        }

        return groupOrder.map((name) => ({
            name,
            triangles: trianglesByGroup.get(name) ?? [],
        }));
    }

    private placeGeometryLineVertex(
        origin: THREE.Vector3,
        right: THREE.Vector3,
        vertex: GeometryLineVertex,
    ): THREE.Vector3 {
        return origin.clone()
            .add(right.clone().multiplyScalar(vertex.lateral))
            .add(new THREE.Vector3(0, vertex.height, 0));
    }
}