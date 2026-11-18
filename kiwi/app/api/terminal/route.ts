import { apiGuard } from "@/lib/api";
import { KiwiTerminal } from "@/lib/terminal";

/** Open sessions: -> { sessions: TerminalInfo[] } */
export async function GET(req: Request) {
    const denied = await apiGuard(req, { mutating: false });
    if (denied) return denied;
    return Response.json({ sessions: KiwiTerminal.list() });
}

/** Open a terminal: { cols, rows } -> { id } */
export async function POST(req: Request) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    const { cols, rows } = (await req.json().catch(() => ({}))) as { cols?: number; rows?: number };
    try {
        const id = KiwiTerminal.create(cols ?? 80, rows ?? 24);
        return Response.json({ id, sessions: KiwiTerminal.list() });
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 429 });
    }
}
