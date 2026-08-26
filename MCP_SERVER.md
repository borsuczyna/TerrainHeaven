# TerrainHeaven MCP Server

The MCP server lets Claude, Codex, or another MCP client inspect and edit the live TerrainHeaven scene. It uses stdio for MCP and a local WebSocket bridge (`127.0.0.1:47831`) to the open browser editor.

## Setup

Install and start TerrainHeaven normally:

```bash
npm install
npm run dev
```

Keep the editor tab open. Configure the MCP client to run this repository's server:

```json
{
  "mcpServers": {
    "terrainheaven": {
      "command": "npm",
      "args": ["run", "mcp", "--silent"],
      "cwd": "/absolute/path/to/TerrainHeaven"
    }
  }
}
```

For clients without `cwd`, use `npm --prefix /absolute/path/to/TerrainHeaven run mcp --silent`.

The bridge port can be changed with `TERRAINHEAVEN_MCP_PORT`. When using a non-default port, open the editor with `?mcpBridge=ws://127.0.0.1:PORT` or set `VITE_MCP_BRIDGE_URL` before starting Vite.

## Architecture

- `mcp-server/src/server.ts` exposes read, edit, batch, and high-level generation tools.
- `mcp-server/src/project.ts` performs deterministic, testable mutations on TerrainHeaven's existing version-1 project model.
- `mcp-server/src/village.ts` plans a native editable village around the current scene.
- `src/mcp/EditorBridge.ts` is the only browser integration point. It delegates to the existing `ProjectSerializer` and records every MCP mutation in editor undo history.

The MCP never manipulates Three.js internals. It edits the same JSON contract used by normal save/load, so geometry remains owned and validated by TerrainHeaven's existing element deserializers.

## Recommended agent workflow

1. Call `connection_status`.
2. Call `inspect_scene`, then `query_elements` for relevant regions/types.
3. Plan changes using native world coordinates.
4. Use focused creation tools or `apply_batch` for one atomic history entry.
5. Inspect again and patch individual elements if needed.

High-level tools include complete houses and a small Polish village. Lower-level tools cover terrain, sculpting, roads/bridges, rivers, fences, foliage, element queries/patches, node connections, safe deletion, batch edits, and full project export.
