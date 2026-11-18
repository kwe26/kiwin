import { apiGuard } from "@/lib/api";
import { KiwiSoftware } from "@/lib/software";

type Ctx = { params: Promise<{ id: string }> };

/** Install progress and installed versions, polled by the software page. */
export async function GET(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: false });
    if (denied) return denied;
    const { id } = await params;
    return Response.json({
        job: KiwiSoftware.job(id),
        installed: KiwiSoftware.installed(id),
        current: KiwiSoftware.current(id),
    });
}
