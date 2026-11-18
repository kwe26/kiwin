import { apiGuard } from "@/lib/api";
import { KiwiTasks, type TaskAction } from "@/lib/tasks";

/** Processes inside the isolation, with CPU/memory history (polled by the Task Manager page). */
export async function GET(req: Request) {
    const denied = await apiGuard(req, { mutating: false });
    if (denied) return denied;
    return Response.json(await KiwiTasks.snapshot(), { headers: { "cache-control": "no-store" } });
}

/** { pid, action: "suspend" | "resume" | "terminate" | "kill" } */
export async function POST(req: Request) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    const { pid, action } = (await req.json().catch(() => ({}))) as { pid?: number; action?: TaskAction };
    try {
        KiwiTasks.signal(Number(pid), action as TaskAction);
        return Response.json({ ok: true });
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
    }
}
