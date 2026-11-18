import { revalidatePath } from "next/cache";
import { apiGuard } from "@/lib/api";
import { KiwiMail } from "@/lib/mail";

/**
 * Add a mail domain: { domain } -> newline-delimited JSON progress lines,
 * { step } while it works, then { done: true } or { error }.
 */
export async function POST(req: Request) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    const { domain } = (await req.json().catch(() => ({}))) as { domain?: string };
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
            const send = (o: object) => {
                try {
                    ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
                } catch {}
            };
            try {
                await KiwiMail.addDomain(String(domain ?? ""), (step, level = "info") => send({ step, level }));
                revalidatePath("/mail");
                send({ done: true });
            } catch (e) {
                send({ error: (e as Error).message });
            }
            ctrl.close();
        },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
