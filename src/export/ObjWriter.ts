// Builds a plain Wavefront OBJ + MTL pair from already-flattened, unindexed triangle
// data. Using a real OBJ (rather than embedding raw position/uv arrays in JSON) means
// the Unity side can lean on Unity's own built-in model importer to build the Mesh -
// including the right-handed-to-left-handed conversion Unity's importer already does
// for any OBJ, the same as one authored in Blender - instead of us hand-constructing
// vertex buffers in C#.
export interface ObjGroup {
    name: string;
    materialName: string;
    // Flat xyz per vertex, 3 unique vertices per triangle (matches how this app already
    // builds every mesh - see WorldElement.setGeometry()).
    positions: number[];
    uvs: number[];
}

export interface ObjMaterial {
    name: string;
    // Relative path from the .mtl file to the texture, e.g. "../Textures/grass.png".
    textureRelativePath: string | null;
}

// Vertices within this world-space distance are treated as "the same point" when
// looking for neighbouring triangles to smooth with.
const WELD_EPSILON = 1e-4;

const positionKey = (x: number, y: number, z: number): string => (
    `${Math.round(x / WELD_EPSILON)},${Math.round(y / WELD_EPSILON)},${Math.round(z / WELD_EPSILON)}`
);

const faceNormal = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
): [number, number, number] => {
    const ux = bx - ax; const uy = by - ay; const uz = bz - az;
    const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    return [nx / length, ny / length, nz / length];
};

// "Auto smooth" normals, the same idea as Blender's angle-based shading: a vertex
// averages the face normals of every triangle meeting at that point, but only those
// within `thresholdDegrees` of its own triangle's face - so a continuously curving
// terrain surface shades smoothly while a genuinely sharp corner (a curb, a bank edge)
// stays crisp instead of being smeared flat. Exported meshes never share vertices
// between triangles (see ObjGroup doc above), so this is computed purely from matching
// positions across every group in the object - two groups (e.g. road and sidewalk)
// meeting at a shared edge smooth together exactly when that edge is shallow enough to
// deserve it, and stay separate otherwise.
function computeAutoSmoothNormals(groups: ObjGroup[], thresholdDegrees: number): number[][] {
    const cosThreshold = Math.cos((thresholdDegrees * Math.PI) / 180);

    interface Face { keys: [string, string, string]; normal: [number, number, number] }
    const faces: Face[] = [];
    const rangeByGroup: { start: number; count: number }[] = [];

    for (const group of groups) {
        const triangleCount = group.positions.length / 9;
        rangeByGroup.push({ start: faces.length, count: triangleCount });
        for (let tri = 0; tri < triangleCount; tri++) {
            const o = tri * 9;
            const p = group.positions;
            faces.push({
                keys: [
                    positionKey(p[o], p[o + 1], p[o + 2]),
                    positionKey(p[o + 3], p[o + 4], p[o + 5]),
                    positionKey(p[o + 6], p[o + 7], p[o + 8]),
                ],
                normal: faceNormal(
                    p[o], p[o + 1], p[o + 2],
                    p[o + 3], p[o + 4], p[o + 5],
                    p[o + 6], p[o + 7], p[o + 8],
                ),
            });
        }
    }

    const facesAtPosition = new Map<string, number[]>();
    faces.forEach((face, index) => {
        for (const key of face.keys) {
            const existing = facesAtPosition.get(key);
            if (existing) existing.push(index);
            else facesAtPosition.set(key, [index]);
        }
    });

    return groups.map((group, groupIndex) => {
        const range = rangeByGroup[groupIndex];
        const normals = new Array<number>(group.positions.length);
        for (let localTri = 0; localTri < range.count; localTri++) {
            const face = faces[range.start + localTri];
            for (let corner = 0; corner < 3; corner++) {
                const neighbours = facesAtPosition.get(face.keys[corner])!;
                let nx = 0; let ny = 0; let nz = 0;
                for (const neighbourIndex of neighbours) {
                    const neighbour = faces[neighbourIndex];
                    const dot = face.normal[0] * neighbour.normal[0]
                        + face.normal[1] * neighbour.normal[1]
                        + face.normal[2] * neighbour.normal[2];
                    if (dot < cosThreshold) continue;
                    nx += neighbour.normal[0]; ny += neighbour.normal[1]; nz += neighbour.normal[2];
                }
                const length = Math.hypot(nx, ny, nz) || 1;
                const out = (localTri * 3 + corner) * 3;
                normals[out] = nx / length;
                normals[out + 1] = ny / length;
                normals[out + 2] = nz / length;
            }
        }
        return normals;
    });
}

export function buildObj(mtlFileName: string, objectName: string, groups: ObjGroup[], autoSmoothDegrees = 30): string {
    const lines: string[] = [`mtllib ${mtlFileName}`, `o ${sanitizeName(objectName)}`];
    const normalsByGroup = computeAutoSmoothNormals(groups, autoSmoothDegrees);
    let vertexCount = 0;

    groups.forEach((group, groupIndex) => {
        const triangleCount = group.positions.length / 9;
        if (triangleCount === 0) return;
        const normals = normalsByGroup[groupIndex];
        lines.push(`g ${sanitizeName(group.name)}`, `usemtl ${sanitizeName(group.materialName)}`);
        for (let tri = 0; tri < triangleCount; tri++) {
            for (let vert = 0; vert < 3; vert++) {
                const pi = (tri * 3 + vert) * 3;
                const ti = (tri * 3 + vert) * 2;
                lines.push(`v ${formatNumber(group.positions[pi])} ${formatNumber(group.positions[pi + 1])} ${formatNumber(group.positions[pi + 2])}`);
                lines.push(`vt ${formatNumber(group.uvs[ti])} ${formatNumber(group.uvs[ti + 1])}`);
                lines.push(`vn ${formatNumber(normals[pi])} ${formatNumber(normals[pi + 1])} ${formatNumber(normals[pi + 2])}`);
            }
            const a = vertexCount + 1;
            const b = vertexCount + 2;
            const c = vertexCount + 3;
            lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
            vertexCount += 3;
        }
    });

    return `${lines.join('\n')}\n`;
}

export function buildMtl(materials: ObjMaterial[]): string {
    const lines: string[] = [];
    for (const material of materials) {
        lines.push(`newmtl ${sanitizeName(material.name)}`, 'Kd 1 1 1', 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1');
        if (material.textureRelativePath) lines.push(`map_Kd ${material.textureRelativePath}`);
    }
    return `${lines.join('\n')}\n`;
}

function sanitizeName(name: string): string {
    return name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '');
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? value.toFixed(6) : '0';
}
