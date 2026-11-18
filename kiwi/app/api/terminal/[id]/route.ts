import { apiGuard } from "@/lib/api";
import { KiwiTerminal } from "@/lib/terminal";

type Ctx = { params: Promise<{ id: string }> };

/** Output as server-sent events: base64 data chunks, then an "exit" event. */
export async function GET(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: false });
    if (denied) return denied;
    const { id } = await params;
    if (!KiwiTerminal.exists(id)) return Response.json({ error: "No such terminal" }, { status: 404 });

    const enc = new TextEncoder();
    let detach = () => {};
    let ping: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
            const send = (s: string) => {
                try {
                    ctrl.enqueue(enc.encode(s));
                } catch {}
            };
            detach = KiwiTerminal.attach(id, (chunk) => {
                if (chunk) send(`data: ${Buffer.from(chunk).toString("base64")}\n\n`);
                else {
                    send("event: exit\ndata: \n\n");
                    clearInterval(ping);
                    try {
                        ctrl.close();
                    } catch {}
                }
            });
            // Keep proxies from timing out an idle shell.
            ping = setInterval(() => send(": ping\n\n"), 20_000);
            req.signal.addEventListener("abort", () => {
                clearInterval(ping);
                detach();
            });
        },
        cancel() {
            clearInterval(ping);
            detach();
        },
    });
    return new Response(stream, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            // no-transform keeps Next's compression from buffering the stream.
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
        },
    });
}

/** Input: { type: "input", data } | { type: "resize", cols, rows } */
export async function POST(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { type?: string; data?: string; cols?: number; rows?: number };
    try {
        if (body.type === "input" && typeof body.data === "string") KiwiTerminal.write(id, body.data);
        else if (body.type === "resize") KiwiTerminal.resize(id, body.cols ?? 80, body.rows ?? 24);
        else return Response.json({ error: "Bad request" }, { status: 400 });
        return new Response(null, { status: 204 });
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 410 });
    }
}

export async function DELETE(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    KiwiTerminal.close((await params).id);
    return new Response(null, { status: 204 });
}
