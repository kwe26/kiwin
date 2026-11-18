import { apiGuard } from "@/lib/api";
import { KiwiMysql } from "@/lib/mysql";

/** ?db=<name> | all -> mysqldump as a .sql download. */
export async function GET(req: Request) {
    const denied = await apiGuard(req, { mutating: false });
    if (denied) return denied;
    const db = new URL(req.url).searchParams.get("db") ?? "all";
    if (db !== "all" && !/^[A-Za-z0-9_]{1,64}$/.test(db)) return Response.json({ error: "Invalid database name" }, { status: 400 });
    try {
        const { stdout, done } = await KiwiMysql.dump(db === "all" ? null : db);
        done.then((error) => error && console.error(`kiwi: export of ${db} failed: ${error}`));
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        return new Response(stdout, {
            headers: {
                "content-type": "application/sql; charset=utf-8",
                "content-disposition": `attachment; filename="${db === "all" ? "all-databases" : db}-${stamp}.sql"`,
                "cache-control": "no-store, no-transform",
                "x-accel-buffering": "no",
            },
        });
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
    }
}
