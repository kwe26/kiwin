import { apiGuard } from "@/lib/api";
import { KiwiDesktop } from "@/lib/desktop";

type Ctx = { params: Promise<{ id: string }> };

/** VNC server -> browser as server-sent events: base64 chunks, then a "close" event. */
export async function GET(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: false });
    if (denied) return denied;
    const { id } = await params;
    if (!KiwiDesktop.exists(id)) return Response.json({ error: "No such desktop connection" }, { status: 404 });

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
            try {
                detach = KiwiDesktop.attach(id, (chunk) => {
                    if (chunk) send(`data: ${Buffer.from(chunk).toString("base64")}\n\n`);
                    else {
                        send("event: close\ndata: \n\n");
                        clearInterval(ping);
                        try {
                            ctrl.close();
                        } catch {}
                    }
                });
            } catch (e) {
                send(`event: close\ndata: ${(e as Error).message}\n\n`);
                ctrl.close();
                return;
            }
            send(": open\n\n");
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
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
        },
    });
}

/** Browser -> VNC server: the raw bytes as the request body. */
export async function POST(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    const { id } = await params;
    try {
        KiwiDesktop.write(id, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 204 });
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 410 });
    }
}

export async function DELETE(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    KiwiDesktop.disconnect((await params).id);
    return new Response(null, { status: 204 });
}
