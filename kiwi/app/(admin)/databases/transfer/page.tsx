import type { Metadata } from "next";
import { Download } from "lucide-react";
import { MysqlGate } from "@/components/mysql-gate";
import { SqlImportForm } from "@/components/sql-import";
import { KiwiMysql } from "@/lib/mysql";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Import / Export" };

export default async function DatabaseTransfer() {
    await requireUser();
    const gate = MysqlGate({ title: "Import / Export" });
    if (gate) return gate;
    const status = await KiwiMysql.status().catch(() => null);
    const dbs = status?.state === "running" ? await KiwiMysql.listDatabases().catch(() => null) : null;

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Import / Export</h1>
                    <p>Move databases in and out as <code>.sql</code> dumps (mysqldump format).</p>
                </div>
            </div>
            {dbs === null ? (
                <section className="card"><p className="empty">Could not reach MySQL. Check the mysql service.</p></section>
            ) : (
                <div className="grid grid-2">
                    <section className="card">
                        <h2>Export</h2>
                        <p className="hint">
                            One database exports its tables only, so it can be imported under any name. All databases
                            includes <code>CREATE DATABASE</code> statements. Users and MySQL&apos;s own schemas are not included.
                        </p>
                        {dbs.length === 0 ? <p className="empty">No databases to export yet.</p> : (
                            <form method="get" action="/api/databases/export" className="stack">
                                <label>Database
                                    <select name="db" defaultValue="all">
                                        <option value="all">All databases ({dbs.length})</option>
                                        {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
                                    </select>
                                </label>
                                <div className="row">
                                    <button type="submit" className="btn btn-primary"><Download size={15} aria-hidden /> Download .sql</button>
                                </div>
                            </form>
                        )}
                    </section>
                    <section className="card">
                        <h2>Import</h2>
                        <p className="hint">
                            Into one existing database, or a dump of all databases (creates them; create users afterwards
                            with Change password on the list). Dumps that touch MySQL&apos;s system schemas are refused.
                        </p>
                        <SqlImportForm databases={dbs} />
                    </section>
                </div>
            )}
        </>
    );
}
