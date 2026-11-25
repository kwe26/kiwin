import { randomBytes } from "node:crypto";
import type { Socket } from "bun";

// Bridges between a browser and a unix socket speaking RFB (VNC): the X.org
// desktop's Xvnc socket, and one per running virtual machine.
//
// The browser never talks VNC to the network: noVNC's bytes travel over an
// event stream (server -> browser) and POSTs (browser -> server) to the bridge
// here, which holds the socket connection. Same transport as the web terminal,
// so it works through any proxy that can do the panel.

interface Bridge {
    id: string;
    socket: Socket<undefined> | null;
    /** Server bytes waiting for the browser's event stream to attach. */
    pending: Uint8Array[];
    listener: ((chunk: Uint8Array | null) => void) | null;
    /** Browser bytes the socket couldn't take yet. */
    outbox: Uint8Array[];
    lastSeen: number;
    closed: boolean;
}

const IDLE_MS = 30_000;

/**
 * A set of bridges, kept on globalThis under `key` so Next's module reloads in
 * development don't orphan live connections.
 */
export class SocketBridges {
    private bridges: Map<string, Bridge>;

    constructor(key: string, private max: number) {
        const g = globalThis as Record<string, unknown>;
        this.bridges = (g[`__kiwiBridges_${key}`] ??= new Map<string, Bridge>()) as Map<string, Bridge>;
        if (!g[`__kiwiSweeper_${key}`]) {
            const timer = setInterval(() => this.sweep(), 10_000);
            (timer as { unref?: () => void }).unref?.();
            g[`__kiwiSweeper_${key}`] = timer;
        }
    }

    /** Drop closed bridges and ones whose viewer never came back. */
    sweep() {
        const now = Date.now();
        for (const b of this.bridges.values()) {
            if (b.closed || (!b.listener && now - b.lastSeen > IDLE_MS)) this.disconnect(b.id);
        }
    }

    get size(): number {
        return this.bridges.size;
    }

    /** Connect to `socket` and return the id the browser uses to attach. */
    async connect(socket: string, tooMany: string): Promise<string> {
        this.sweep();
        if (this.bridges.size >= this.max) throw new Error(tooMany);
        const id = randomBytes(16).toString("hex");
        const bridge: Bridge = { id, socket: null, pending: [], listener: null, outbox: [], lastSeen: Date.now(), closed: false };
        this.bridges.set(id, bridge);
        try {
            bridge.socket = await Bun.connect({
                unix: socket,
                socket: {
                    data: (_s, data) => {
                        const chunk = new Uint8Array(data);
                        if (bridge.listener) bridge.listener(chunk);
                        else bridge.pending.push(chunk);
                    },
                    drain: (s) => {
                        while (bridge.outbox.length) {
                            const next = bridge.outbox[0];
                            const n = s.write(next);
                            if (n < next.length) {
                                bridge.outbox[0] = next.subarray(n);
                                return;
                            }
                            bridge.outbox.shift();
                        }
                    },
                    close: () => this.disconnect(id),
                    error: () => this.disconnect(id),
                },
            });
        } catch (e) {
            this.bridges.delete(id);
            throw e;
        }
        return id;
    }

    exists(id: string): boolean {
        return this.bridges.has(id);
    }

    /** One viewer per connection (VNC is stateful): replays what arrived before it attached. */
    attach(id: string, listener: (chunk: Uint8Array | null) => void): () => void {
        const b = this.bridges.get(id);
        if (!b) throw new Error("No such connection");
        if (b.listener) throw new Error("Already attached");
        for (const c of b.pending) listener(c);
        b.pending = [];
        b.listener = listener;
        b.lastSeen = Date.now();
        // The event stream closing ends the VNC connection; noVNC reconnects with a new one.
        return () => this.disconnect(id);
    }

    write(id: string, data: Uint8Array) {
        const b = this.bridges.get(id);
        if (!b || !b.socket || b.closed) throw new Error("Connection closed");
        b.lastSeen = Date.now();
        if (b.outbox.length) {
            b.outbox.push(data);
            return;
        }
        const n = b.socket.write(data);
        if (n < data.length) b.outbox.push(data.subarray(n));
    }

    disconnect(id: string) {
        const b = this.bridges.get(id);
        if (!b) return;
        this.bridges.delete(id);
        b.closed = true;
        try {
            b.socket?.end();
        } catch {}
        b.listener?.(null);
    }

    /** Close every bridge (the thing behind the socket is going away). */
    closeAll() {
        for (const id of [...this.bridges.keys()]) this.disconnect(id);
    }
}
