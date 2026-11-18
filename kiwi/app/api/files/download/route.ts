import { posix } from "node:path";
import { statSync } from "node:fs";
import { apiGuard } from "@/lib/api";
import { clean } from "@/lib/files";

export async function GET(req: Request) {
    const denied = await apiGuard(req, { mutating: false });
    if (denied) return denied;
    const path = clean(new URL(req.url).searchParams.get("path") ?? "");
    let size: number;
    try {
        const st = statSync(path);
        if (!st.isFile()) return Response.json({ error: "Not a file" }, { status: 400 });
        size = st.size;
    } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
    }
    const name = posix.basename(path);
    return new Response(Bun.file(path).stream(), {
        headers: {
            "content-type": "application/octet-stream",
            "content-length": String(size),
            "content-disposition": `attachment; filename="${name.replace(/["\\\r\n]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            "x-content-type-options": "nosniff",
        },
    });
}
