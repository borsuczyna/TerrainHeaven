import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import SceneManager from './SceneManager';
import Road from '../elements/Road';
import RoadJunction, { type JunctionArm } from '../elements/RoadJunction';

interface Endpoint {
    road: Road;
    nodeIndex: 0 | 1;
    pos: THREE.Vector3;
}

interface TrackedJunction {
    element: RoadJunction;
    signature: string;
}

// A junction forms wherever 3+ distinct roads' own endpoints land within this distance of
// each other - a tolerance in the same spirit as WALL_SNAP_DISTANCE/WALL_SNAP_MARGIN
// elsewhere in the project ("close enough to read as the same point" without requiring
// pixel-exact placement), not a literal shared-node requirement. Two roads meeting
// end-to-end (the normal case, handled by their own butt-jointed cross-sections) never
// forms a junction on its own - only 3 or more.
const CLUSTER_DISTANCE = 0.6;

// Replaces the old manually-placed Intersection element entirely: instead of the user
// dropping an Intersection and hand-merging every road end onto it, a RoadJunction is
// auto-built (and continuously kept in sync) wherever 3+ roads' endpoints already coincide.
// Runs once per frame from App's animate loop, before Scene.flushDirty() so a newly
// (dis)appeared junction is already part of the element list terrain cutting reads that
// same frame. See RoadJunction's own class-level note for the geometry/terrain side.
@singleton()
export default class RoadJunctionManager {
    private junctions = new Map<string, TrackedJunction>();
    private readonly roadIds = new WeakMap<Road, number>();
    private nextRoadId = 0;
    private lastQuickSignature = '';

    constructor(@inject(SceneManager) private readonly scene: SceneManager) {}

    public refresh(): void {
        const roads = this.scene.getElements().filter((el): el is Road => el instanceof Road);
        // Cheap early exit for the overwhelmingly common "nothing moved this frame" case -
        // the full O(n^2) clustering pass below only runs when some road's endpoints or
        // width/edge profile actually changed since the last check.
        const quickSignature = roads.map((road) => this.roadSignature(road)).join('|');
        if (quickSignature === this.lastQuickSignature) return;
        this.lastQuickSignature = quickSignature;
        this.rebuild(roads);
    }

    private roadId(road: Road): number {
        let id = this.roadIds.get(road);
        if (id === undefined) {
            id = this.nextRoadId++;
            this.roadIds.set(road, id);
        }
        return id;
    }

    private roadSignature(road: Road): string {
        const a = road.nodeA.mesh.position;
        const b = road.nodeB.mesh.position;
        return [
            this.roadId(road),
            a.x.toFixed(3), a.y.toFixed(3), a.z.toFixed(3),
            b.x.toFixed(3), b.y.toFixed(3), b.z.toFixed(3),
            road.width.toFixed(3), road.edgeType, road.sidewalkWidth.toFixed(3), road.curbHeight.toFixed(3),
        ].join(',');
    }

    private rebuild(roads: Road[]): void {
        const endpoints: Endpoint[] = [];
        for (const road of roads) {
            endpoints.push({ road, nodeIndex: 0, pos: road.nodeA.mesh.position });
            endpoints.push({ road, nodeIndex: 1, pos: road.nodeB.mesh.position });
        }

        // Plain union-find over endpoint pairs within CLUSTER_DISTANCE - road counts in an
        // editor scene are small (tens, not thousands), so the O(n^2) distance pass is
        // cheap, and it only runs at all when roadSignature() detected a real change.
        const parent = endpoints.map((_, i) => i);
        const find = (i: number): number => {
            while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
            return i;
        };
        for (let i = 0; i < endpoints.length; i++) {
            for (let j = i + 1; j < endpoints.length; j++) {
                if (endpoints[i].pos.distanceTo(endpoints[j].pos) <= CLUSTER_DISTANCE) {
                    const ri = find(i);
                    const rj = find(j);
                    if (ri !== rj) parent[ri] = rj;
                }
            }
        }

        const clusters = new Map<number, Endpoint[]>();
        endpoints.forEach((endpoint, i) => {
            const root = find(i);
            const group = clusters.get(root);
            if (group) group.push(endpoint); else clusters.set(root, [endpoint]);
        });

        const nextJunctions = new Map<string, TrackedJunction>();
        for (const group of clusters.values()) {
            const distinctRoads = new Set(group.map((e) => e.road));
            // Skips a degenerate cluster where one road contributes both its own endpoints
            // (a tiny loop) as well as ordinary 2-road end-to-end meetings, which already
            // get a clean butt-jointed cross-section from the roads' own geometry and need
            // no fan.
            if (distinctRoads.size < 3 || distinctRoads.size !== group.length) continue;

            // Identity key: which roads/ends participate, independent of their current
            // position - stable across a drag so an in-progress junction updates in place
            // instead of being torn down and recreated every frame.
            const participantKey = group.map((e) => `${this.roadId(e.road)}:${e.nodeIndex}`).sort().join('|');
            const signature = group
                .map((e) => `${this.roadId(e.road)}:${e.nodeIndex}:${this.roadSignature(e.road)}`)
                .sort()
                .join('#');

            const existing = this.junctions.get(participantKey);
            if (existing && existing.signature === signature) {
                nextJunctions.set(participantKey, existing);
                continue;
            }

            const element = existing ? existing.element : new RoadJunction();
            element.setArms(group.map((e) => this.buildArm(e)));
            if (existing) element.update();
            else this.scene.add(element);
            nextJunctions.set(participantKey, { element, signature });
        }

        for (const [key, tracked] of this.junctions) {
            if (!nextJunctions.has(key)) this.scene.remove(tracked.element);
        }
        this.junctions = nextJunctions;
    }

    private buildArm(endpoint: Endpoint): JunctionArm {
        const { road, nodeIndex } = endpoint;
        const basis = road.getNodeBasis(nodeIndex);
        // getNodeBasis' forward always points in the curve's own travel direction - at the
        // start node that already points away from the junction into the road, but at the
        // end node it points further past the road's own end, so it has to be flipped to
        // mean "away from this junction" in both cases.
        const outward = nodeIndex === 0 ? basis.forward.clone() : basis.forward.clone().negate();
        return {
            point: endpoint.pos.clone(),
            outward,
            halfWidth: road.width / 2,
            sidewalkWidth: road.getSidewalkWidth(),
            curbHeight: road.getCurbHeight(),
        };
    }
}
