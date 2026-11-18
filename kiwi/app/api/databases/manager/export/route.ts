import { apiGuard } from "@/lib/api";
import { KiwiMysqlAdmin } from "@/lib/mysql-admin";

/** ?db=&table=&format=csv|sql: one table, streamed. Needs the MySQL Manager on. */
export async function GET(req: Request) {
    const denied = await apiGuard(req, { mutating: false });
    if (denied) return denied;
    if (!KiwiMysqlAdmin.enabled()) return Response.json({ error: "The MySQL Manager is off" }, { status: 403 });
    const u = new URL(req.url).searchParams;
    const db = u.get("db") ?? "";
    const table = u.get("table") ?? "";
    const format = u.get("format") === "sql" ? "sql" : "csv";
    try {
        if (!(await KiwiMysqlAdmin.exists(db, table))) return Response.json({ error: "No such table" }, { status: 404 });
        const name = `${db}.${table}`.replace(/[^\w.-]/g, "_");
        let body: ReadableStream<Uint8Array>;
        if (format === "csv") body = KiwiMysqlAdmin.csv(db, table);
        else {
            const dump = await KiwiMysqlAdmin.dumpTable(db, table);
            dump.done.then((error) => error && console.error(`kiwi: export of ${db}.${table} failed: ${error}`));
            body = dump.stdout;
        }
        return new Response(body, {
            headers: {
                "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/sql; charset=utf-8",
                "content-disposition": `attachment; filename="${name}.${format}"`,
                "cache-control": "no-store, no-transform",
            },
        });
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
    }
}
