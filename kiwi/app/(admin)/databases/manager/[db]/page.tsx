import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, Eraser, Table2, Trash2 } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SqlConsole, TableColumns } from "@/components/mysql-manager";
import { Crumbs, ManagerError, ManagerOff, fmtBytes } from "@/components/mysql-manager-parts";
import { COLUMN_TYPES, KiwiMysqlAdmin, SYSTEM_SCHEMAS } from "@/lib/mysql-admin";
import { requireUser } from "@/lib/session";
import { createTable, dropDatabase, tableOp } from "@/app/mysql-actions";

type Props = { params: Promise<{ db: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    return { title: `${decodeURIComponent((await params).db)} · MySQL Manager` };
}

export default async function DatabasePage({ params }: Props) {
    await requireUser();
    if (!KiwiMysqlAdmin.enabled()) return <ManagerOff />;
    const db = decodeURIComponent((await params).db);
    let data;
    try {
        if (!(await KiwiMysqlAdmin.exists(db))) notFound();
        data = await Promise.all([KiwiMysqlAdmin.tables(db), KiwiMysqlAdmin.engines(), KiwiMysqlAdmin.collations()]);
    } catch (e) {
        if ((e as { digest?: string }).digest?.startsWith("NEXT_")) throw e;
        return <ManagerError message={(e as Error).message} />;
    }
    const [tables, engines, collations] = data;
    const readOnly = SYSTEM_SCHEMAS.includes(db.toLowerCase());
    const href = (t: string, tab?: string) => `/databases/manager/${encodeURIComponent(db)}/${encodeURIComponent(t)}${tab ? `?tab=${tab}` : ""}`;
    const total = tables.reduce((n, t) => n + Number(t.bytes ?? 0), 0);

    return (
        <>
            <div className="page-head">
                <div>
                    <Crumbs db={db} />
                    <h1>{db}</h1>
                    <p>{tables.length} table{tables.length === 1 ? "" : "s"} · {fmtBytes(total)}{readOnly ? " · MySQL's own database, read-only" : ""}</p>
                </div>
                {!readOnly && <a className="btn btn-secondary" href={`/api/databases/export?db=${encodeURIComponent(db)}`}><Download size={15} aria-hidden /> Export .sql</a>}
            </div>
            <section className="card table-card">
                <div className="table-wrap">
                    <table className="table">
                        <thead><tr><th>Table</th><th className="num">Rows</th><th className="num">Size</th><th>Engine</th><th>Collation</th><th><span className="sr-only">Actions</span></th></tr></thead>
                        <tbody>
                            {tables.length === 0 && <tr><td colSpan={6} className="hint">No tables yet.</td></tr>}
                            {tables.map((t) => {
                                const view = t.type === "VIEW";
                                return (
                                    <tr key={t.name}>
                                        <td>
                                            <Link href={href(t.name)}><Table2 size={14} aria-hidden /> {t.name}</Link>
                                            {view && <span className="chip" style={{ marginLeft: 6 }}>view</span>}
                                            {t.comment && <div className="hint">{t.comment}</div>}
                                        </td>
                                        <td className="num">{t.rows === null ? "-" : `~${Number(t.rows).toLocaleString()}`}</td>
                                        <td className="num">{fmtBytes(t.bytes)}</td>
                                        <td>{t.engine ?? "-"}</td>
                                        <td className="hint">{t.collation ?? "-"}</td>
                                        <td>
                                            <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                                                <Link className="btn btn-ghost" href={href(t.name)}>Browse</Link>
                                                <Link className="btn btn-ghost" href={href(t.name, "structure")}>Structure</Link>
                                                {!readOnly && !view && (
                                                    <ActionForm action={tableOp.bind(null, db, t.name, "truncate")} className="inline-form">
                                                        <SubmitButton variant="ghost" confirm={`Delete every row in ${t.name}?`}><Eraser size={14} aria-label="Empty" /></SubmitButton>
                                                    </ActionForm>
                                                )}
                                                {!readOnly && (
                                                    <ActionForm action={tableOp.bind(null, db, t.name, view ? "dropView" : "drop")} className="inline-form">
                                                        <SubmitButton variant="ghost" confirm={`Drop ${t.name}${view ? "" : " and all its rows"}? This can't be undone.`}><Trash2 size={14} aria-label="Drop" /></SubmitButton>
                                                    </ActionForm>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </section>

            {!readOnly && (
                <section className="card" style={{ marginTop: 16 }}>
                    <h2>Create table</h2>
                    <ActionForm action={createTable.bind(null, db)} className="stack">
                        <div className="mm-col-grid">
                            <label>Table name<input type="text" name="table" required maxLength={64} spellCheck={false} autoCapitalize="none" /></label>
                            <label>Engine<select name="engine" defaultValue="InnoDB">{engines.map((e) => <option key={e}>{e}</option>)}</select></label>
                            <label>Collation<select name="collation" defaultValue=""><option value="">Database default</option>{collations.map((c) => <option key={c}>{c}</option>)}</select></label>
                        </div>
                        <TableColumns types={COLUMN_TYPES} />
                        <div><SubmitButton>Create table</SubmitButton></div>
                    </ActionForm>
                </section>
            )}

            <section className="card" style={{ marginTop: 16 }}>
                <h2>SQL in {db}</h2>
                <SqlConsole db={db} />
            </section>

            {!readOnly && (
                <section className="card" style={{ marginTop: 16, maxWidth: 560 }}>
                    <h2>Drop database</h2>
                    <p className="hint">Deletes {db} and every table in it. Type its name to confirm.</p>
                    <ActionForm action={dropDatabase.bind(null, db)} className="stack">
                        <input type="text" name="confirm" placeholder={db} autoComplete="off" spellCheck={false} aria-label="Database name" />
                        <div><SubmitButton variant="danger"><Trash2 size={15} aria-hidden /> Drop {db}</SubmitButton></div>
                    </ActionForm>
                </section>
            )}
        </>
    );
}
