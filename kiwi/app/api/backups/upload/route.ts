import { rmSync } from "node:fs";
import { revalidatePath } from "next/cache";
import { apiGuard } from "@/lib/api";
import { KiwiBackups } from "@/lib/backups";

/** ?name=<file>.tar.gz, body = a backup made by Kiwin (here or on another server). */
export async function POST(req: Request) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    if (!req.body) return Response.json({ error: "Empty upload" }, { status: 400 });
    let target;
    try {
        target = KiwiBackups.uploadTarget(new URL(req.url).searchParams.get("name") ?? "");
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    try {
        await Bun.write(target.tmp, new Response(req.body));
        await KiwiBackups.accept(target.tmp, target.file);
    } catch (e) {
        rmSync(target.tmp, { force: true });
        return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    revalidatePath("/settings/backups");
    return Response.json({ ok: true });
}
