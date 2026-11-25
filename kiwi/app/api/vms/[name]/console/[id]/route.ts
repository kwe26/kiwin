import { apiGuard } from "@/lib/api";
import { KiwiVms } from "@/lib/vms";

// The same transport as the Desktop page (see app/api/desktop/[id]): bytes from
// the machine's VNC server as server-sent events, bytes to it as POST bodies.

type Ctx = { params: Promise<{ name: string; id: string }> };

export async function GET(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: false });
    if (denied) return denied;
    const { id } = await params;
    if (!KiwiVms.consoleExists(id)) return Response.json({ error: "No such console connection" }, { status: 404 });

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
                detach = KiwiVms.attach(id, (chunk) => {
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

export async function POST(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    const { id } = await params;
    try {
        KiwiVms.write(id, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 204 });
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 410 });
    }
}

export async function DELETE(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    KiwiVms.disconnect((await params).id);
    return new Response(null, { status: 204 });
}
