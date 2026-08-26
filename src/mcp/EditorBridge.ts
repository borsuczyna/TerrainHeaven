import { inject, singleton } from 'tsyringe';
import ProjectSerializer from '../editor/ProjectSerializer';
import HistoryManager from '../editor/HistoryManager';

type BridgeRequest = {
    id: string;
    method: 'ping' | 'getProject' | 'setProject';
    params?: { project?: string; historyLabel?: string };
};

type BridgeResponse = {
    id: string;
    result?: unknown;
    error?: string;
};

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:47831';

/**
 * Small, local-only adapter between the browser editor and the stdio MCP process.
 * The MCP process owns the WebSocket server; the editor reconnects automatically.
 */
@singleton()
export default class EditorBridge {
    private socket: WebSocket | null = null;
    private reconnectTimer: number | null = null;
    private stopped = false;

    constructor(
        @inject(ProjectSerializer) private readonly serializer: ProjectSerializer,
        @inject(HistoryManager) private readonly history: HistoryManager,
    ) {}

    public start(): void {
        this.stopped = false;
        this.connect();
    }

    public stop(): void {
        this.stopped = true;
        if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.socket?.close();
        this.socket = null;
    }

    private connect(): void {
        if (this.stopped || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;

        const queryUrl = new URLSearchParams(window.location.search).get('mcpBridge');
        const configuredUrl = queryUrl || import.meta.env.VITE_MCP_BRIDGE_URL || DEFAULT_BRIDGE_URL;
        try {
            this.socket = new WebSocket(configuredUrl);
        } catch {
            this.scheduleReconnect();
            return;
        }

        this.socket.addEventListener('message', (event) => this.handleMessage(String(event.data)));
        this.socket.addEventListener('close', () => {
            this.socket = null;
            this.scheduleReconnect();
        });
        this.socket.addEventListener('error', () => this.socket?.close());
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer !== null) return;
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 1500);
    }

    private handleMessage(raw: string): void {
        let request: BridgeRequest;
        try {
            request = JSON.parse(raw) as BridgeRequest;
        } catch {
            return;
        }

        const response: BridgeResponse = { id: request.id };
        try {
            if (request.method === 'ping') {
                response.result = { editor: 'TerrainHeaven', protocolVersion: 1 };
            } else if (request.method === 'getProject') {
                response.result = JSON.parse(this.serializer.save());
            } else if (request.method === 'setProject') {
                const project = request.params?.project;
                if (typeof project !== 'string') throw new Error('setProject requires a serialized project');
                // Loading is destructive internally (it clears the current scene first),
                // so retain a rollback snapshot if a malformed external edit is rejected.
                const previous = this.serializer.save();
                try {
                    this.serializer.load(project);
                } catch (error) {
                    this.serializer.load(previous);
                    throw error;
                }
                this.history.record(request.params?.historyLabel || 'MCP edit');
                response.result = { applied: true };
            } else {
                throw new Error(`Unsupported bridge method: ${String(request.method)}`);
            }
        } catch (error) {
            response.error = error instanceof Error ? error.message : String(error);
        }

        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(response));
    }
}
