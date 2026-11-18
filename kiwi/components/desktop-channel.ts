/**
 * A WebSocket-shaped channel for noVNC over kiwi's desktop bridge: bytes from
 * the VNC server arrive as server-sent events, bytes to it are POSTed in small
 * batches, in order. noVNC attaches to anything with these members.
 */
export class BridgeChannel {
    binaryType = "arraybuffer";
    protocol = "";
    readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    private es: EventSource;
    private queue: Uint8Array[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private chain = Promise.resolve();

    constructor(private id: string) {
        this.es = new EventSource(`/api/desktop/${id}`);
        this.es.onopen = () => {
            if (this.readyState !== "connecting") return;
            this.readyState = "open";
            this.onopen?.({});
        };
        this.es.onmessage = (e) => {
            const bin = atob(e.data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            this.onmessage?.({ data: bytes.buffer });
        };
        this.es.addEventListener("close", (e) => this.shut((e as MessageEvent).data || "The desktop closed the connection"));
        // Never let EventSource reconnect on its own: a VNC stream can't resume.
        this.es.onerror = () => this.shut("Connection lost");
    }

    send(data: ArrayBuffer | Uint8Array) {
        if (this.readyState !== "open") return;
        // noVNC reuses its send buffer, so copy.
        this.queue.push(new Uint8Array(data instanceof ArrayBuffer ? data : data.slice().buffer));
        if (!this.timer) this.timer = setTimeout(() => this.flush(), 8);
    }

    private flush() {
        this.timer = undefined;
        if (!this.queue.length) return;
        const size = this.queue.reduce((n, c) => n + c.length, 0);
        const body = new Uint8Array(size);
        let off = 0;
        for (const c of this.queue) {
            body.set(c, off);
            off += c.length;
        }
        this.queue = [];
        this.chain = this.chain.then(() =>
            fetch(`/api/desktop/${this.id}`, { method: "POST", body, headers: { "content-type": "application/octet-stream" } })
                .then((r) => {
                    if (r.status === 410) this.shut("The desktop closed the connection");
                })
                .catch(() => {}),
        );
    }

    close() {
        if (this.readyState === "closed") return;
        this.readyState = "closing";
        fetch(`/api/desktop/${this.id}`, { method: "DELETE" }).catch(() => {});
        this.shut("Disconnected");
    }

    private shut(reason: string) {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        clearTimeout(this.timer);
        this.es.close();
        this.onclose?.({ code: 1000, reason, wasClean: true });
    }
}
