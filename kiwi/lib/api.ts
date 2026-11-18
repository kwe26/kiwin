import { headers } from "next/headers";
import { currentUser } from "./session";

/**
 * Guard for route handlers: signed in, and (for state-changing requests) sent
 * from this site - the same origin check Next.js applies to Server Actions.
 */
export async function apiGuard(req: Request, { mutating }: { mutating: boolean }): Promise<Response | null> {
    if (!(await currentUser())) return Response.json({ error: "Not signed in" }, { status: 401 });
    if (mutating) {
        const h = await headers();
        const origin = h.get("origin");
        const host = h.get("x-forwarded-host") ?? h.get("host");
        const allowed = new Set([host, ...(process.env.KIWI_ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? [])]);
        let originHost: string | null = null;
        try {
            originHost = origin ? new URL(origin).host : null;
        } catch {}
        if (!originHost || !allowed.has(originHost)) return Response.json({ error: "Cross-origin request refused" }, { status: 403 });
    }
    return null;
}
