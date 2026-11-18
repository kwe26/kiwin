import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, Trash2 } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { BrowseGrid, ColumnDialog, RowDialog, SqlConsole, type BrowseRow, type ColumnInfo } from "@/components/mysql-manager";
import { Crumbs, ManagerError, ManagerOff } from "@/components/mysql-manager-parts";
import { COLUMN_TYPES, KiwiMysqlAdmin, PAGE_SIZES, SYSTEM_SCHEMAS, display, ident } from "@/lib/mysql-admin";
import { requireUser } from "@/lib/session";
import { addForeignKey, addIndex, dropColumn, dropForeignKey, dropIndex, tableOp } from "@/app/mysql-actions";

type Tab = "browse" | "structure" | "sql" | "operations";
type Props = {
    params: Promise<{ db: string; table: string }>;
    searchParams: Promise<{ tab?: string; page?: string; size?: string; sort?: string; desc?: string; where?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const p = await params;
    return { title: `${decodeURIComponent(p.table)} · ${decodeURIComponent(p.db)}` };
}

const TABS: [Tab, string][] = [["browse", "Browse"], ["structure", "Structure"], ["sql", "SQL"], ["operations", "Operations"]];

export default async function TablePage({ params, searchParams }: Props) {
    await requireUser();
    if (!KiwiMysqlAdmin.enabled()) return <ManagerOff />;
    const p = await params;
    const q = await searchParams;
    const db = decodeURIComponent(p.db);
    const table = decodeURIComponent(p.table);
    const tab = (TABS.some(([t]) => t === q.tab) ? q.tab : "browse") as Tab;
    const readOnly = SYSTEM_SCHEMAS.includes(db.toLowerCase());
    const base = `/databases/manager/${encodeURIComponent(db)}/${encodeURIComponent(table)}`;

    let body: React.ReactNode;
    let isView = false;
    try {
        const tables = await KiwiMysqlAdmin.tables(db);
        const info = tables.find((t) => t.name === table);
        if (!info) notFound();
        isView = info.type === "VIEW";
        if (tab === "browse") body = await browse(db, table, base, q, readOnly || isView);
        else if (tab === "structure") body = await structure(db, table, readOnly || isView);
        else if (tab === "sql") body = <section className="card"><SqlConsole db={db} initial={`SELECT * FROM ${ident(table)} LIMIT 100;`} /></section>;
        else body = await operations(db, table, info, readOnly, isView);
    } catch (e) {
        if ((e as { digest?: string }).digest?.startsWith("NEXT_")) throw e;
        body = <ManagerError message={(e as Error).message} />;
    }

    return (
        <>
            <div className="page-head">
                <div>
                    <Crumbs db={db} table={table} />
                    <h1>{table}{isView ? <span className="chip" style={{ marginLeft: 8 }}>view</span> : null}</h1>
                </div>
            </div>
            <div className="sw-tabs mm-tabs" role="tablist" aria-label="Table">
                {TABS.map(([t, label]) => (
                    <Link key={t} href={t === "browse" ? base : `${base}?tab=${t}`} role="tab" aria-selected={t === tab} className={t === tab ? "active" : ""}>{label}</Link>
                ))}
            </div>
            {body}
        </>
    );
}

const toColumnInfo = (c: Awaited<ReturnType<typeof KiwiMysqlAdmin.columns>>[number]): ColumnInfo => ({
    name: c.name, type: c.type, nullable: c.nullable, default: c.default, extra: c.extra, key: c.key, comment: c.comment, collation: c.collation,
});

async function browse(db: string, table: string, base: string, q: Awaited<Props["searchParams"]>, readOnly: boolean) {
    const size = Number(q.size) || 25;
    const page = Number(q.page) || 1;
    const where = q.where ?? "";
    let result;
    try {
        result = await KiwiMysqlAdmin.browse(db, table, { page, size, sort: q.sort, desc: q.desc === "1", where });
    } catch (e) {
        return (
            <section className="card stack">
                <FilterForm base={base} where={where} size={size} />
                <ManagerError message={(e as Error).message} />
            </section>
        );
    }
    const columns = result.columns.map(toColumnInfo);
    const key = readOnly ? null : result.key;
    const rows: BrowseRow[] = result.rows.map((r) => ({
        key: key ? Object.fromEntries(key.map((k) => [k, r[k] === null || r[k] === undefined ? null : String(r[k])])) : null,
        cells: columns.map((c) => display(r[c.name])),
    }));
    const link = (over: Record<string, string | number | undefined>) => {
        const params = new URLSearchParams();
        const all = { size: result.size, sort: q.sort, desc: q.desc, where: where || undefined, page: result.page, ...over };
        for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== "" && !(k === "page" && v === 1) && !(k === "size" && v === 25)) params.set(k, String(v));
        const s = params.toString();
        return s ? `${base}?${s}` : base;
    };
    const sortHref = Object.fromEntries(columns.map((c) => [c.name, link({ sort: c.name, desc: q.sort === c.name && q.desc !== "1" ? "1" : undefined, page: 1 })]));
    const pages = Math.max(1, Math.ceil(result.total / result.size));
    const from = result.total ? (result.page - 1) * result.size + 1 : 0;
    const to = Math.min(result.total, result.page * result.size);

    return (
        <section className="card stack" style={{ gap: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
                <FilterForm base={base} where={where} size={result.size} sort={q.sort} desc={q.desc} />
                <div className="row">
                    {!readOnly && <RowDialog db={db} table={table} columns={columns} trigger="insert" />}
                    <a className="btn btn-secondary" href={`/api/databases/manager/export?db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}&format=csv`}><Download size={15} aria-hidden /> CSV</a>
                    <a className="btn btn-secondary" href={`/api/databases/manager/export?db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}&format=sql`}><Download size={15} aria-hidden /> SQL</a>
                </div>
            </div>
            <BrowseGrid db={db} table={table} columns={columns} rows={rows} sortHref={sortHref} sort={q.sort} desc={q.desc === "1"} keyColumns={key} />
            <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="hint">{from}-{to} of {result.total.toLocaleString()}{where ? " matching" : ""}</span>
                <div className="row">
                    <Link className="btn btn-ghost" aria-disabled={result.page <= 1} href={link({ page: 1 })}>« First</Link>
                    <Link className="btn btn-ghost" aria-disabled={result.page <= 1} href={link({ page: Math.max(1, result.page - 1) })}>‹ Previous</Link>
                    <span className="hint">Page {result.page} of {pages}</span>
                    <Link className="btn btn-ghost" aria-disabled={result.page >= pages} href={link({ page: Math.min(pages, result.page + 1) })}>Next ›</Link>
                    <Link className="btn btn-ghost" aria-disabled={result.page >= pages} href={link({ page: pages })}>Last »</Link>
                </div>
            </div>
        </section>
    );
}

function FilterForm({ base, where, size, sort, desc }: { base: string; where: string; size: number; sort?: string; desc?: string }) {
    return (
        <form method="get" action={base} className="row mm-filter">
            {sort && <input type="hidden" name="sort" value={sort} />}
            {desc && <input type="hidden" name="desc" value={desc} />}
            <label className="mm-where"><span className="label-text">WHERE <span className="opt">(e.g. price &gt; 10 AND name LIKE &apos;a%&apos;)</span></span>
                <input type="text" name="where" defaultValue={where} spellCheck={false} autoCapitalize="none" className="mono-input" />
            </label>
            <label>Rows per page
                <select name="size" defaultValue={String(size)}>{PAGE_SIZES.map((n) => <option key={n}>{n}</option>)}</select>
            </label>
            <button type="submit" className="btn btn-secondary">Apply</button>
            {where && <Link className="btn btn-ghost" href={base}>Clear</Link>}
        </form>
    );
}

async function structure(db: string, table: string, readOnly: boolean) {
    const [raw, indexes, fks, all, create] = await Promise.all([
        KiwiMysqlAdmin.columns(db, table), KiwiMysqlAdmin.indexes(db, table), KiwiMysqlAdmin.foreignKeys(db, table),
        KiwiMysqlAdmin.allColumns(db), KiwiMysqlAdmin.createStatement(db, table),
    ]);
    const columns = raw.map(toColumnInfo);
    const names = columns.map((c) => c.name);
    return (
        <div className="stack" style={{ gap: 16 }}>
            <section className="card table-card">
                <div className="table-toolbar">
                    <h2>Columns</h2>
                    {!readOnly && <ColumnDialog db={db} table={table} positions={names} types={COLUMN_TYPES} />}
                </div>
                <div className="table-wrap">
                    <table className="table">
                        <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Null</th><th>Default</th><th>Extra</th><th>Collation</th><th>Comment</th><th /></tr></thead>
                        <tbody>
                            {columns.map((c, i) => (
                                <tr key={c.name}>
                                    <td className="hint">{i + 1}</td>
                                    <td><strong>{c.name}</strong>{c.key === "PRI" ? " 🔑" : c.key === "UNI" ? <span className="chip" style={{ marginLeft: 6 }}>unique</span> : c.key === "MUL" ? <span className="chip" style={{ marginLeft: 6 }}>index</span> : null}</td>
                                    <td><code>{c.type}</code></td>
                                    <td>{c.nullable ? "Yes" : "No"}</td>
                                    <td>{c.default === null ? <span className="mm-null">{c.nullable ? "NULL" : "none"}</span> : <code>{c.default}</code>}</td>
                                    <td className="hint">{c.extra || "-"}</td>
                                    <td className="hint">{c.collation ?? "-"}</td>
                                    <td className="hint">{c.comment || "-"}</td>
                                    <td>
                                        {!readOnly && (
                                            <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                                                <ColumnDialog db={db} table={table} column={c} positions={names} types={COLUMN_TYPES} />
                                                <ActionForm action={dropColumn.bind(null, db, table, c.name)} className="inline-form">
                                                    <SubmitButton variant="ghost" confirm={`Drop column ${c.name} and its data?`}><Trash2 size={14} aria-label={`Drop ${c.name}`} /></SubmitButton>
                                                </ActionForm>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <div className="grid grid-split" style={{ alignItems: "start" }}>
                <section className="card">
                    <h2>Indexes</h2>
                    <ul className="mm-list">
                        {indexes.length === 0 && <li className="hint">No indexes.</li>}
                        {indexes.map((i) => (
                            <li key={i.name}>
                                <div><strong>{i.name}</strong> <span className="chip">{i.name === "PRIMARY" ? "primary" : i.type === "FULLTEXT" ? "fulltext" : i.unique ? "unique" : "index"}</span>
                                    <div className="hint">{i.columns.join(", ")}</div></div>
                                {!readOnly && (
                                    <ActionForm action={dropIndex.bind(null, db, table, i.name)} className="inline-form">
                                        <SubmitButton variant="ghost" confirm={`Drop index ${i.name}?`}><Trash2 size={14} aria-label={`Drop ${i.name}`} /></SubmitButton>
                                    </ActionForm>
                                )}
                            </li>
                        ))}
                    </ul>
                    {!readOnly && (
                        <ActionForm action={addIndex.bind(null, db, table)} className="stack mm-add">
                            <div className="mm-col-grid">
                                <label>Type<select name="kind" defaultValue="INDEX"><option>INDEX</option><option>UNIQUE</option><option>PRIMARY</option><option>FULLTEXT</option></select></label>
                                <label><span className="label-text">Name <span className="opt">(optional)</span></span><input type="text" name="name" spellCheck={false} /></label>
                            </div>
                            <fieldset className="mm-checks"><legend>Columns, in order</legend>
                                {names.map((n) => <label key={n} className="check"><input type="checkbox" name="columns" value={n} /> <span>{n}</span></label>)}
                            </fieldset>
                            <div><SubmitButton variant="secondary">Add index</SubmitButton></div>
                        </ActionForm>
                    )}
                </section>
                <section className="card">
                    <h2>Foreign keys</h2>
                    <ul className="mm-list">
                        {fks.length === 0 && <li className="hint">No foreign keys.</li>}
                        {fks.map((f) => (
                            <li key={`${f.name}-${f.column}`}>
                                <div><strong>{f.column}</strong> → {f.refTable}.{f.refColumn}
                                    <div className="hint">{f.name} · on delete {f.onDelete.toLowerCase()} · on update {f.onUpdate.toLowerCase()}</div></div>
                                {!readOnly && (
                                    <ActionForm action={dropForeignKey.bind(null, db, table, f.name)} className="inline-form">
                                        <SubmitButton variant="ghost" confirm={`Drop foreign key ${f.name}?`}><Trash2 size={14} aria-label={`Drop ${f.name}`} /></SubmitButton>
                                    </ActionForm>
                                )}
                            </li>
                        ))}
                    </ul>
                    {!readOnly && (
                        <ActionForm action={addForeignKey.bind(null, db, table)} className="stack mm-add">
                            <div className="mm-col-grid">
                                <label>Column<select name="column">{names.map((n) => <option key={n}>{n}</option>)}</select></label>
                                <label>References
                                    <select name="ref">{all.map((c) => <option key={`${c.table}.${c.column}`} value={`${c.table}\u0000${c.column}`}>{c.table}.{c.column}</option>)}</select>
                                </label>
                                <label>On delete<select name="onDelete" defaultValue="RESTRICT">{["RESTRICT", "CASCADE", "SET NULL", "NO ACTION"].map((r) => <option key={r}>{r}</option>)}</select></label>
                                <label>On update<select name="onUpdate" defaultValue="RESTRICT">{["RESTRICT", "CASCADE", "SET NULL", "NO ACTION"].map((r) => <option key={r}>{r}</option>)}</select></label>
                            </div>
                            <div><SubmitButton variant="secondary">Add foreign key</SubmitButton></div>
                        </ActionForm>
                    )}
                </section>
            </div>

            <section className="card">
                <details>
                    <summary><strong>CREATE statement</strong></summary>
                    <pre className="log" style={{ marginTop: 10 }}>{create}</pre>
                </details>
            </section>
        </div>
    );
}

async function operations(db: string, table: string, info: Awaited<ReturnType<typeof KiwiMysqlAdmin.tables>>[number], readOnly: boolean, isView: boolean) {
    if (readOnly) return <section className="card"><p className="hint">{db} is MySQL&apos;s own database: its tables can&apos;t be changed here.</p></section>;
    const [engines, collations, databases] = await Promise.all([KiwiMysqlAdmin.engines(), KiwiMysqlAdmin.collations(), KiwiMysqlAdmin.databases()]);
    const targets = databases.map((d) => d.name).filter((n) => !SYSTEM_SCHEMAS.includes(n));
    return (
        <div className="grid grid-split" style={{ alignItems: "start" }}>
            <section className="card">
                <h2>Rename or move</h2>
                <ActionForm action={tableOp.bind(null, db, table, "rename")} className="stack">
                    <div className="mm-col-grid">
                        <label>Database<select name="toDb" defaultValue={db}>{targets.map((n) => <option key={n}>{n}</option>)}</select></label>
                        <label>New name<input type="text" name="to" defaultValue={table} required spellCheck={false} /></label>
                    </div>
                    <div><SubmitButton variant="secondary">Rename</SubmitButton></div>
                </ActionForm>
            </section>
            {!isView && (
                <section className="card">
                    <h2>Copy</h2>
                    <ActionForm action={tableOp.bind(null, db, table, "copy")} className="stack">
                        <label>Name of the copy<input type="text" name="to" defaultValue={`${table}_copy`} required spellCheck={false} /></label>
                        <label className="check"><input type="checkbox" name="data" defaultChecked /> <span>With its rows</span></label>
                        <div><SubmitButton variant="secondary">Copy table</SubmitButton></div>
                    </ActionForm>
                </section>
            )}
            {!isView && (
                <section className="card">
                    <h2>Table options</h2>
                    <ActionForm action={tableOp.bind(null, db, table, "options")} className="stack">
                        <div className="mm-col-grid">
                            <label>Engine<select name="engine" defaultValue={info.engine ?? ""}>{engines.map((e) => <option key={e}>{e}</option>)}</select></label>
                            <label><span className="label-text">Convert to <span className="opt">(rewrites text columns)</span></span>
                                <select name="collation" defaultValue=""><option value="">Keep {info.collation}</option>{collations.map((c) => <option key={c}>{c}</option>)}</select>
                            </label>
                            <label>Next auto increment<input type="text" name="autoIncrement" inputMode="numeric" defaultValue={info.autoIncrement ?? ""} /></label>
                            <label>Comment<input type="text" name="comment" defaultValue={info.comment} /></label>
                        </div>
                        <div><SubmitButton variant="secondary">Save options</SubmitButton></div>
                    </ActionForm>
                </section>
            )}
            <section className="card">
                <h2>Delete</h2>
                <div className="row">
                    {!isView && (
                        <ActionForm action={tableOp.bind(null, db, table, "truncate")} className="inline-form">
                            <SubmitButton variant="secondary" confirm={`Delete every row in ${table}?`}>Empty table</SubmitButton>
                        </ActionForm>
                    )}
                    <ActionForm action={tableOp.bind(null, db, table, isView ? "dropView" : "drop")} className="inline-form">
                        <SubmitButton variant="danger" confirm={`Drop ${table}? This can't be undone.`}><Trash2 size={15} aria-hidden /> Drop {isView ? "view" : "table"}</SubmitButton>
                    </ActionForm>
                </div>
            </section>
        </div>
    );
}
