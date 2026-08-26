import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ProjectData } from './types.js';

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
};

type BridgeResponse = { id: string; result?: unknown; error?: string };

export class EditorBridgeServer {
    private server: WebSocketServer | null = null;
    private client: WebSocket | null = null;
    private readonly pending = new Map<string, PendingRequest>();
    private retryTimer: NodeJS.Timeout | null = null;
    private closed = false;

    public constructor(private readonly port = 47831) {
        this.listen();
    }

    private listen(): void {
        if (this.closed || this.server) return;

        const server = new WebSocketServer({ host: '127.0.0.1', port: this.port });
        this.server = server;
        server.on('connection', (socket) => {
            this.client?.close(1000, 'A newer TerrainHeaven editor connected');
            this.client = socket;
            socket.on('message', (payload) => this.handleResponse(String(payload)));
            socket.on('close', () => {
                if (this.client === socket) this.client = null;
            });
        });
        server.on('listening', () => console.error(`[terrainheaven-mcp] Editor bridge listening on ws://127.0.0.1:${this.port}`));
        server.on('error', (error) => {
            console.error(`[terrainheaven-mcp] Bridge error: ${error.message}; retrying in 1500ms`);
            if (this.server === server) this.server = null;
            server.close();
            this.scheduleRetry();
        });
    }

    private scheduleRetry(): void {
        if (this.closed || this.retryTimer) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.listen();
        }, 1500);
    }

    public get connected(): boolean {
        return this.client?.readyState === this.client?.OPEN;
    }

    public async ping(): Promise<unknown> {
        return this.request('ping');
    }

    public async getProject(): Promise<ProjectData> {
        return await this.request('getProject') as ProjectData;
    }

    public async setProject(project: ProjectData, historyLabel: string): Promise<void> {
        await this.request('setProject', { project: JSON.stringify(project), historyLabel });
    }

    public close(): void {
        this.closed = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error('Editor bridge closed'));
        }
        this.pending.clear();
        this.client?.close();
        this.client = null;
        this.server?.close();
        this.server = null;
    }

    private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
        if (!this.client || this.client.readyState !== this.client.OPEN) {
            throw new Error('TerrainHeaven editor is not connected. Start it with `npm run dev` and keep the editor tab open.');
        }
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Editor bridge timed out while calling ${method}`));
            }, 15_000);
            this.pending.set(id, { resolve, reject, timer });
            this.client!.send(JSON.stringify({ id, method, params }));
        });
    }

    private handleResponse(raw: string): void {
        let response: BridgeResponse;
        try {
            response = JSON.parse(raw) as BridgeResponse;
        } catch {
            return;
        }
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(response.error));
        else pending.resolve(response.result);
    }
}
