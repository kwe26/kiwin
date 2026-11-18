import { apiGuard } from "@/lib/api";
import { KiwiJobs } from "@/lib/jobs";

/** Live state of a background job: { title, lines, done, ok }. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const denied = await apiGuard(req, { mutating: false });
    if (denied) return denied;
    const job = KiwiJobs.get((await params).id);
    if (!job) return Response.json({ error: "No such task (the panel may have restarted)" }, { status: 404 });
    return Response.json(job);
}
