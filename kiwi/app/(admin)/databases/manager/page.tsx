import type { Metadata } from "next";
import Link from "next/link";
import { Database, Power } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SqlConsole } from "@/components/mysql-manager";
import { Crumbs, ManagerError, ManagerOff, fmtBytes } from "@/components/mysql-manager-parts";
import { KiwiMysql } from "@/lib/mysql";
import { KiwiMysqlAdmin, SYSTEM_SCHEMAS } from "@/lib/mysql-admin";
import { requireUser } from "@/lib/session";
import { createDatabase, killQuery, setMysqlManager } from "@/app/mysql-actions";

export const metadata: Metadata = { title: "MySQL Manager" };

const uptime = (s: number) => (s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} days`);

export default async function Manager() {
    await requireUser();
    if (!KiwiMysqlAdmin.enabled()) return <ManagerOff />;
    if (!process.env.KIWI_MYSQL_URL && !KiwiMysql.isSetup()) {
        return <><div className="page-head"><h1>MySQL Manager</h1></div><p className="notice notice-error">MySQL isn&apos;t set up yet. Set it up from Databases first.</p></>;
    }
    let data;
    try {
        data = await Promise.all([KiwiMysqlAdmin.server(), KiwiMysqlAdmin.databases(), KiwiMysqlAdmin.collations(), KiwiMysqlAdmin.processes()]);
    } catch (e) {
        return <><div className="page-head"><h1>MySQL Manager</h1></div><ManagerError message={`Can't reach MySQL: ${(e as Error).message}`} /></>;
    }
    const [server, databases, collations, processes] = data;
    const own = databases.filter((d) => !SYSTEM_SCHEMAS.includes(d.name));
    const system = databases.filter((d) => SYSTEM_SCHEMAS.includes(d.name));

    return (
        <>
            <div className="page-head">
                <div>
                    <Crumbs />
                    <h1>MySQL Manager</h1>
                    <p>MySQL {server.version} · up {uptime(Number(server.uptime))} · {server.collation}</p>
                </div>
                <ActionForm action={setMysqlManager.bind(null, false)} className="inline-form">
                    <SubmitButton variant="secondary"><Power size={15} aria-hidden /> Turn off</SubmitButton>
                </ActionForm>
            </div>
            <div className="grid mm-split">
                <section className="card table-card">
                    <div className="table-toolbar"><h2>Databases</h2></div>
                    <div className="table-wrap">
                        <table className="table">
                            <thead><tr><th>Name</th><th className="num">Tables</th><th className="num">Size</th><th>Collation</th></tr></thead>
                            <tbody>
                                {[...own, ...system].map((d) => (
                                    <tr key={d.name}>
                                        <td className="mm-nowrap"><Link href={`/databases/manager/${encodeURIComponent(d.name)}`}><Database size={14} aria-hidden /> {d.name}</Link>{SYSTEM_SCHEMAS.includes(d.name) && <span className="chip" style={{ marginLeft: 6 }}>system · read-only</span>}</td>
                                        <td className="num">{d.tables}</td>
                                        <td className="num">{fmtBytes(d.bytes)}</td>
                                        <td className="hint">{d.collation}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
                <section className="card">
                    <h2>Create database</h2>
                    <ActionForm action={createDatabase} className="stack">
                        <label>Name<input type="text" name="name" required maxLength={64} spellCheck={false} autoCapitalize="none" /></label>
                        <label>Collation
                            <select name="collation" defaultValue="utf8mb4_unicode_ci">
                                <option value="">Server default ({server.collation})</option>
                                {collations.map((c) => <option key={c}>{c}</option>)}
                            </select>
                        </label>
                        <div><SubmitButton>Create</SubmitButton></div>
                    </ActionForm>
                </section>
            </div>
            <section className="card" style={{ marginTop: 16 }}>
                <h2>SQL</h2>
                <p className="hint">Runs as MySQL&apos;s root user. Don&apos;t change root@localhost: the panel uses it.</p>
                <SqlConsole db={null} />
            </section>
            <section className="card table-card" style={{ marginTop: 16 }}>
                <div className="table-toolbar"><h2>Running queries</h2></div>
                <div className="table-wrap">
                    <table className="table">
                        <thead><tr><th className="num">Id</th><th>User</th><th>Database</th><th>Command</th><th className="num">Time</th><th>Query</th><th /></tr></thead>
                        <tbody>
                            {processes.map((p) => (
                                <tr key={p.Id}>
                                    <td className="num">{p.Id}</td>
                                    <td>{p.User}</td>
                                    <td>{p.db ?? <span className="hint">-</span>}</td>
                                    <td>{p.Command}{p.State ? <div className="hint">{p.State}</div> : null}</td>
                                    <td className="num">{p.Time}s</td>
                                    <td><code className="mm-query">{p.Info ?? ""}</code></td>
                                    <td>{p.Command !== "Daemon" && p.Info !== "SHOW FULL PROCESSLIST" && (
                                        <ActionForm action={killQuery.bind(null, Number(p.Id))} className="inline-form">
                                            <SubmitButton variant="ghost" confirm={`Kill connection ${p.Id}?`}>Kill</SubmitButton>
                                        </ActionForm>
                                    )}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </>
    );
}
