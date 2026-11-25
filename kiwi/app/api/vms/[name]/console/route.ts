import { apiGuard } from "@/lib/api";
import { KiwiVms } from "@/lib/vms";

type Ctx = { params: Promise<{ name: string }> };

/** Open a VNC connection to a running machine: -> { id } */
export async function POST(req: Request, { params }: Ctx) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    if (!KiwiVms.isInstalled()) return Response.json({ error: "Install QEMU from Software first" }, { status: 409 });
    try {
        return Response.json({ id: await KiwiVms.connect((await params).name) });
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 503 });
    }
}
