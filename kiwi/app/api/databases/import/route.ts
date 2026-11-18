import { revalidatePath } from "next/cache";
import { apiGuard } from "@/lib/api";
import { KiwiMysql } from "@/lib/mysql";

/** ?db=<name> | all, body = the .sql file, streamed into the mysql client. */
export async function POST(req: Request) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    const db = new URL(req.url).searchParams.get("db") ?? "";
    if (db !== "all" && !/^[A-Za-z0-9_]{1,64}$/.test(db)) return Response.json({ error: "Invalid database name" }, { status: 400 });
    if (!req.body) return Response.json({ error: "Empty upload" }, { status: 400 });
    try {
        const { bytes } = await KiwiMysql.restore(db === "all" ? null : db, req.body);
        revalidatePath("/databases");
        const mb = (bytes / 1024 / 1024).toFixed(1);
        return Response.json({ ok: true, message: `Imported ${mb} MB${db === "all" ? "" : ` into ${db}`}.` });
    } catch (e) {
        return Response.json({ error: `Import failed: ${(e as Error).message}` }, { status: 400 });
    }
}
