#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EditorBridgeServer } from './bridge.js';
import { ProjectDocument } from './project.js';
import { createPolishVillage } from './village.js';
import type { Bounds2, ProjectData, Vec3 } from './types.js';

const vector = z.object({ x: z.number(), y: z.number().default(0), z: z.number() });
const bounds = z.object({ minX: z.number(), maxX: z.number(), minZ: z.number(), maxZ: z.number() });
const bridgePort = Number.parseInt(process.env.TERRAINHEAVEN_MCP_PORT ?? '47831', 10);
const bridge = new EditorBridgeServer(Number.isFinite(bridgePort) ? bridgePort : 47831);
const server = new McpServer({ name: 'terrainheaven', version: '1.0.0' });
let mutationQueue: Promise<void> = Promise.resolve();

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

async function readDocument(): Promise<ProjectDocument> {
    return new ProjectDocument(await bridge.getProject());
}

async function mutate<T>(label: string, action: (document: ProjectDocument) => T | Promise<T>): Promise<T> {
    let output!: T;
    let failure: unknown;
    const run = mutationQueue.then(async () => {
        try {
            const document = await readDocument();
            output = await action(document);
            await bridge.setProject(document.data, label);
        } catch (error) {
            failure = error;
        }
    });
    mutationQueue = run;
    await run;
    if (failure) throw failure;
    return output;
}

server.registerTool('connection_status', {
    title: 'TerrainHeaven connection status',
    description: 'Check whether a live TerrainHeaven browser editor is connected to this MCP server. Call before editing.',
    annotations: { readOnlyHint: true },
}, async () => result(bridge.connected ? { connected: true, editor: await bridge.ping() } : { connected: false, action: 'Run npm run dev and open TerrainHeaven in a browser.' }));

server.registerTool('inspect_scene', {
    title: 'Inspect current scene',
    description: 'Read a compact inventory of the live scene: element counts, IDs, types, bounds, node counts and foliage totals. Use this before planning any large edit.',
    inputSchema: z.object({ includeElements: z.boolean().default(true) }),
    annotations: { readOnlyHint: true },
}, async ({ includeElements }) => {
    const summary = (await readDocument()).summary();
    if (!includeElements) summary.elements = [];
    return result(summary);
});

server.registerTool('query_elements', {
    title: 'Query scene elements',
    description: 'Read full serialized TerrainHeaven elements, optionally filtered by native type and/or 2D world bounds. Returns editable properties, nodes, textures and geometry settings.',
    inputSchema: z.object({
        type: z.enum(['road', 'intersection', 'terrain', 'terrainCutSpline', 'river', 'fence', 'stairs', 'terrainPolygon', 'building']).optional(),
        bounds: bounds.optional(),
    }),
    annotations: { readOnlyHint: true },
}, async (input) => result((await readDocument()).query(input.type, input.bounds as Bounds2 | undefined)));

server.registerTool('get_element', {
    title: 'Get one scene element',
    description: 'Read one live element by the numeric ID returned by inspect_scene or query_elements.',
    inputSchema: z.object({ id: z.number().int().nonnegative() }),
    annotations: { readOnlyHint: true },
}, async ({ id }) => result((await readDocument()).get(id)));

server.registerTool('create_terrain', {
    title: 'Create editable terrain',
    description: 'Add a native adaptive TerrainHeaven terrain tile with smoothing and triangle-budget controls.',
    inputSchema: z.object({ center: vector, width: z.number().positive(), length: z.number().positive(), meshDetail: z.number().min(0.5).max(5).default(2), triangleLimit: z.number().int().min(100).max(5000).default(1500), maxSlope: z.number().min(1).max(89).default(35) }),
}, async ({ center, width, length, ...options }) => result(
    await mutate('MCP: create terrain', (document) => ({ id: document.addTerrain(center, width, length, options) })),
));

server.registerTool('sculpt_terrain', {
    title: 'Sculpt terrain height',
    description: 'Raise or lower every terrain tile under a circular smooth-falloff brush. Positive heightDelta raises; negative lowers.',
    inputSchema: z.object({ center: vector, radius: z.number().positive(), heightDelta: z.number().min(-100).max(100) }),
}, async ({ center, radius, heightDelta }) => result(
    await mutate('MCP: sculpt terrain', (document) => ({ changedSamples: document.sculptTerrain(center, radius, heightDelta) })),
));

server.registerTool('create_road', {
    title: 'Create road path',
    description: 'Create a connected low-poly road from two or more world-space points. Use divisions 0 for straight roads and at most 1-4 for genuine curves. Use create_intersection when three or more roads meet.',
    inputSchema: z.object({ points: z.array(vector).min(2), width: z.number().positive().default(3), lanes: z.number().int().min(1).max(8).default(2), sidewalk: z.boolean().default(false), bridge: z.boolean().default(false), divisions: z.number().int().min(0).max(4).default(0) }),
}, async ({ points, ...options }) => result(
    await mutate('MCP: create road', (document) => ({ ids: document.addRoadPath(points, options) })),
));

server.registerTool('create_intersection', {
    title: 'Create road intersection',
    description: 'Create a native fixed-footprint 3-way T junction or 4-way cross junction. Node indices are west=0, east=1, north=2 and south=3; rotation rotates the whole junction. Connect each road endpoint with connect_elements.',
    inputSchema: z.object({
        center: vector,
        nodeCount: z.union([z.literal(3), z.literal(4)]).default(3),
        width: z.number().min(1).default(8),
        length: z.number().min(1).default(8),
        outletWidth: z.number().min(0.2).default(4),
        outletLength: z.number().nonnegative().default(2),
        rotation: z.number().default(0),
        sidewalk: z.boolean().default(false),
        sidewalkWidth: z.number().min(0.1).default(1),
        curbHeight: z.number().nonnegative().default(0.15),
        roadTexture: z.string().optional(),
        sidewalkTexture: z.string().optional(),
    }),
}, async ({ center, ...options }) => result(
    await mutate('MCP: create intersection', (document) => ({ id: document.addIntersection(center, options) })),
));

server.registerTool('create_river', {
    title: 'Create river path',
    description: 'Create a terrain-conforming native river from a path, including banks, smoothing, irregularity and curve detail.',
    inputSchema: z.object({ points: z.array(vector).min(2), width: z.number().positive().default(4), divisions: z.number().int().min(0).max(128).default(8), bankSlope: z.number().min(1).max(89).default(70), bankSmoothing: z.number().min(0).max(1).default(0.65), irregularity: z.number().min(0).max(1).default(0.25), detail: z.number().min(0.1).max(4).default(1) }),
}, async ({ points, width, ...options }) => result(
    await mutate('MCP: create river', (document) => ({ ids: document.addRiver(points, width, options) })),
));

server.registerTool('create_fence', {
    title: 'Create fence path',
    description: 'Create a native editable fence along two or more points with panel/post geometry controls.',
    inputSchema: z.object({ points: z.array(vector).min(2), style: z.enum(['plane', 'box']).default('plane'), height: z.number().positive().default(1.5), postSpacing: z.number().positive().default(2), postHeight: z.number().positive().default(1.8), divisions: z.number().int().min(0).max(128).default(0) }),
}, async ({ points, ...options }) => result(
    await mutate('MCP: create fence', (document) => ({ ids: document.addFencePath(points, options) })),
));

server.registerTool('create_house', {
    title: 'Create complete house',
    description: 'Create one complete native TerrainHeaven building in a single operation: wall footprint, roof, exterior door, wall-cut windows and optional connected wing. The result stays editable as a Building element.',
    inputSchema: z.object({ center: vector, width: z.number().min(3).default(8), depth: z.number().min(3).default(6), wallHeight: z.number().min(1.8).default(2.8), roofType: z.enum(['flat', 'gable', 'hip', 'tented', 'gambrel']).default('gable'), roofRidgeHeight: z.number().positive().default(1.6), windowsPerSide: z.number().int().min(0).max(6).default(2), doorSide: z.enum(['north', 'south', 'east', 'west']).default('south'), wing: z.boolean().default(false) }),
}, async (input) => result(
    await mutate('MCP: create house', (document) => ({ id: document.addHouse(input) })),
));

server.registerTool('create_foliage_patch', {
    title: 'Scatter vegetation',
    description: 'Scatter deterministic editable foliage instances in a circular area. Reuse an existing typeIndex or create a named foliage type with an optional TerrainHeaven texture path.',
    inputSchema: z.object({ center: vector, radius: z.number().nonnegative(), count: z.number().int().min(0).max(10000), typeIndex: z.number().int().nonnegative().optional(), displayName: z.string().default('MCP Foliage'), texturePath: z.string().default(''), seed: z.number().int().default(1) }),
}, async ({ center, radius, count, ...options }) => result(await mutate('MCP: scatter foliage', (document) => document.addFoliagePatch(center, radius, count, options))));

server.registerTool('create_polish_village', {
    title: 'Generate a small Polish village',
    description: 'High-level planner and builder. It first considers existing scene bounds, then creates terrain, a main road, varied complete houses facing the road, gated plots/fences and vegetation. If center is omitted it places the village beside existing content. All results are native editable elements.',
    inputSchema: z.object({ center: vector.optional(), houseCount: z.number().int().min(2).max(40).default(8), spacing: z.number().min(14).default(22), seed: z.number().int().default(2005), addTerrain: z.boolean().default(true), addFences: z.boolean().default(true), addVegetation: z.boolean().default(true) }),
}, async (input) => result(await mutate('MCP: create Polish village', (document) => createPolishVillage(document, input))));

server.registerTool('update_element', {
    title: 'Modify scene element',
    description: 'Patch serialized properties or nodes of an existing element. Read the element first; type and id cannot be changed. Useful for precise follow-up edits to roads, stairs, terrain, rivers, fences and buildings.',
    inputSchema: z.object({ id: z.number().int().nonnegative(), patch: z.record(z.string(), z.unknown()) }),
}, async ({ id, patch }) => result(await mutate('MCP: update element', (document) => document.updateElement(id, patch))));

server.registerTool('connect_elements', {
    title: 'Connect element nodes',
    description: 'Connect two free native nodes, such as adjacent road endpoints, so TerrainHeaven resolves their shared geometry continuously.',
    inputSchema: z.object({ elementA: z.number().int().nonnegative(), nodeA: z.number().int().nonnegative(), elementB: z.number().int().nonnegative(), nodeB: z.number().int().nonnegative() }),
}, async (input) => result(await mutate('MCP: connect elements', (document) => { document.connect(input.elementA, input.nodeA, input.elementB, input.nodeB); return { connected: true }; })));

server.registerTool('delete_elements', {
    title: 'Delete scene elements',
    description: 'Delete elements by ID and safely remap every remaining element ID and connection. Inspect the scene again after deletion because numeric IDs change.',
    inputSchema: z.object({ ids: z.array(z.number().int().nonnegative()).min(1) }),
    annotations: { destructiveHint: true },
}, async ({ ids }) => result(
    await mutate('MCP: delete elements', (document) => ({ deleted: document.deleteElements(ids) })),
));

server.registerTool('apply_batch', {
    title: 'Apply an atomic scene batch',
    description: 'Apply many creation, patch, connection or deletion operations as one undoable editor history entry. Supported kinds: terrain, sculpt, road, intersection, river, fence, house, foliage, update, connect, delete. If any operation fails, none are sent to the editor.',
    inputSchema: z.object({ operations: z.array(z.object({ kind: z.string() }).passthrough()).min(1).max(250), label: z.string().default('MCP batch edit') }),
}, async ({ operations, label }) => result(await mutate(label, (document) => operations.map((operation) => applyOperation(document, operation)))));

server.registerTool('export_project', {
    title: 'Export current project JSON',
    description: 'Return the complete current TerrainHeaven version-1 project document. Intended for backup or offline inspection; prefer inspect_scene for normal planning.',
    annotations: { readOnlyHint: true },
}, async () => result((await readDocument()).data));

function applyOperation(document: ProjectDocument, operation: Record<string, unknown>): unknown {
    const kind = String(operation.kind);
    if (kind === 'terrain') return { id: document.addTerrain(asVec(operation.center), asNumber(operation.width), asNumber(operation.length), operation) };
    if (kind === 'sculpt') return { changedSamples: document.sculptTerrain(asVec(operation.center), asNumber(operation.radius), asNumber(operation.heightDelta)) };
    if (kind === 'road') return { ids: document.addRoadPath(asPoints(operation.points), operation) };
    if (kind === 'intersection') return { id: document.addIntersection(asVec(operation.center), operation) };
    if (kind === 'river') return { ids: document.addRiver(asPoints(operation.points), asNumber(operation.width, 4), operation) };
    if (kind === 'fence') return { ids: document.addFencePath(asPoints(operation.points), operation) };
    if (kind === 'house') return { id: document.addHouse({ ...operation, center: asVec(operation.center) }) };
    if (kind === 'foliage') return document.addFoliagePatch(asVec(operation.center), asNumber(operation.radius), asNumber(operation.count), operation);
    if (kind === 'update') return document.updateElement(asNumber(operation.id), asRecord(operation.patch));
    if (kind === 'connect') { document.connect(asNumber(operation.elementA), asNumber(operation.nodeA), asNumber(operation.elementB), asNumber(operation.nodeB)); return { connected: true }; }
    if (kind === 'delete') return { deleted: document.deleteElements(asNumberArray(operation.ids)) };
    throw new Error(`Unsupported batch operation kind: ${kind}`);
}

function asVec(value: unknown): Vec3 {
    const parsed = vector.safeParse(value);
    if (!parsed.success) throw new Error(`Expected a vector {x,y,z}: ${parsed.error.message}`);
    return parsed.data;
}

function asPoints(value: unknown): Vec3[] {
    const parsed = z.array(vector).min(2).safeParse(value);
    if (!parsed.success) throw new Error(`Expected at least two path points: ${parsed.error.message}`);
    return parsed.data;
}

function asNumber(value: unknown, fallback?: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (fallback !== undefined) return fallback;
    throw new Error('Expected a finite number');
}

function asNumberArray(value: unknown): number[] {
    const parsed = z.array(z.number().int().nonnegative()).safeParse(value);
    if (!parsed.success) throw new Error(parsed.error.message);
    return parsed.data;
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

process.on('SIGINT', () => { bridge.close(); process.exit(0); });
process.on('SIGTERM', () => { bridge.close(); process.exit(0); });
main().catch((error) => {
    console.error(`[terrainheaven-mcp] Fatal error: ${error instanceof Error ? error.stack : String(error)}`);
    bridge.close();
    process.exit(1);
});
