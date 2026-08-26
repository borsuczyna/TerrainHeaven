import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';

const port = 47931;
const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['mcp-server/dist/server.js'],
    cwd: process.cwd(),
    env: { ...process.env, TERRAINHEAVEN_MCP_PORT: String(port) },
    stderr: 'pipe',
});
const client = new Client({ name: 'terrainheaven-smoke-test', version: '1.0.0' });
let editor;

try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 16, 'expected a comprehensive MCP tool set');
    assert.ok(tools.tools.some((tool) => tool.name === 'create_polish_village'));

    editor = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
        editor.once('open', resolve);
        editor.once('error', reject);
    });

    let project = { version: 1, settings: {}, elements: [], connections: [] };
    editor.on('message', (payload) => {
        const request = JSON.parse(String(payload));
        let response;
        if (request.method === 'ping') response = { id: request.id, result: { editor: 'TerrainHeaven', protocolVersion: 1 } };
        else if (request.method === 'getProject') response = { id: request.id, result: project };
        else if (request.method === 'setProject') {
            project = JSON.parse(request.params.project);
            response = { id: request.id, result: { applied: true } };
        } else response = { id: request.id, error: 'unsupported method' };
        editor.send(JSON.stringify(response));
    });

    const status = await client.callTool({ name: 'connection_status', arguments: {} });
    assert.match(status.content[0].text, /"connected": true/);
    await client.callTool({
        name: 'create_polish_village',
        arguments: { center: { x: 0, y: 0, z: 0 }, houseCount: 4, seed: 5 },
    });
    const inspection = await client.callTool({ name: 'inspect_scene', arguments: { includeElements: false } });
    const scene = JSON.parse(inspection.content[0].text);
    assert.equal(scene.counts.building, 4);
    assert.equal(scene.counts.road, 1);
    assert.ok(scene.counts.fence > 8);
    assert.equal(scene.foliageInstances, 36);
    console.log(`MCP smoke test passed (${tools.tools.length} tools, live bridge mutation verified).`);
} finally {
    editor?.close();
    await client.close();
}
