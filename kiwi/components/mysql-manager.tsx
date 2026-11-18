"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { SubmitButton, type ActionState } from "@/components/forms";
import { deleteRows, runSql, saveColumn, saveRow, type ConsoleResult } from "@/app/mysql-actions";

// Client parts of the MySQL Manager. Values arrive as display text with a
// kind (null / binary / value), never as raw objects.

export interface Cell {
    text: string;
    kind: "null" | "binary" | "value";
}

export interface ColumnInfo {
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
    extra: string;
    key: string;
    comment: string;
    collation: string | null;
}

const isBinary = (type: string) => /^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit|geometry|point|linestring|polygon)/i.test(type);
const isLongText = (type: string) => /text|json/i.test(type);

function useDialog() {
    const ref = useRef<HTMLDialogElement>(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (open) ref.current?.showModal();
        else ref.current?.close();
    }, [open]);
    return { ref, open, setOpen };
}

/** Rendered at the end of <body>: a dialog's form can't sit inside another form (the browse grid is one). */
function Dialog({ d, label, wide, children }: { d: ReturnType<typeof useDialog>; label: string; wide?: boolean; children: ReactNode }) {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    if (!mounted) return null;
    return createPortal(
        <dialog ref={d.ref} className={wide ? "dialog dialog-wide" : "dialog"} aria-label={label} onClose={() => d.setOpen(false)}
            onClick={(e) => e.target === e.currentTarget && d.setOpen(false)}>
            {d.open && children}
        </dialog>,
        document.body,
    );
}

function Head({ title, onClose }: { title: string; onClose: () => void }) {
    return (
        <div className="dialog-head">
            <h2>{title}</h2>
            <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close"><X size={16} aria-hidden /></button>
        </div>
    );
}

/** Closes and refreshes the page when the action succeeds. */
function useDone(state: ActionState, close: () => void) {
    const router = useRouter();
    useEffect(() => {
        if (state.ok) {
            close();
            router.refresh();
        }
    }, [state, close, router]);
}

// ---- SQL console ----------------------------------------------------------------

const HISTORY_KEY = "kiwi.mysql.history";

export function SqlConsole({ db, initial = "" }: { db: string | null; initial?: string }) {
    const [sql, setSql] = useState(initial);
    const [results, setResults] = useState<ConsoleResult[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [history, setHistory] = useState<string[]>([]);
    const router = useRouter();

    useEffect(() => {
        try {
            setHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"));
        } catch {}
    }, []);

    async function run() {
        if (!sql.trim() || busy) return;
        setBusy(true);
        setError(null);
        const r = await runSql(db, sql).catch((e: Error) => ({ error: e.message }));
        setBusy(false);
        if ("error" in r) {
            setResults(null);
            setError(r.error);
        } else {
            setResults(r.results);
            router.refresh();
        }
        const next = [sql.trim(), ...history.filter((h) => h !== sql.trim())].slice(0, 15);
        setHistory(next);
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        } catch {}
    }

    return (
        <div className="stack" style={{ gap: 10 }}>
            <textarea className="env-input mm-sql" rows={6} value={sql} spellCheck={false} aria-label="SQL"
                placeholder={db ? `SELECT * FROM … (in ${db})` : "SHOW DATABASES;"}
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        run();
                    }
                }} />
            <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row">
                    <button type="button" className="btn btn-primary" onClick={run} disabled={busy || !sql.trim()}><Play size={15} aria-hidden /> {busy ? "Running…" : "Run"}</button>
                    <span className="hint">Ctrl+Enter · several statements separated by ;</span>
                </div>
                {history.length > 0 && (
                    <select aria-label="Recent queries" value="" onChange={(e) => e.target.value && setSql(e.target.value)} style={{ width: "auto", maxWidth: 320 }}>
                        <option value="">Recent queries…</option>
                        {history.map((h, i) => <option key={i} value={h}>{h.replace(/\s+/g, " ").slice(0, 80)}</option>)}
                    </select>
                )}
            </div>
            {error && <p className="notice notice-error" role="alert">{error}</p>}
            {results?.map((r, i) => (
                <div key={i} className="stack" style={{ gap: 6 }}>
                    <p className="hint mm-sql-meta"><code>{r.sql.slice(0, 120)}{r.sql.length > 120 ? "…" : ""}</code> · {r.ms} ms ·{" "}
                        {r.affected !== null ? `${r.affected} row${r.affected === 1 ? "" : "s"} affected${r.insertId ? `, insert id ${r.insertId}` : ""}` : `${r.rows.length}${r.truncated ? "+" : ""} row${r.rows.length === 1 ? "" : "s"}`}
                    </p>
                    {r.columns.length > 0 && <Grid columns={r.columns} rows={r.rows} />}
                    {r.truncated && <p className="hint">Showing the first 1000 rows. Add LIMIT to see others.</p>}
                </div>
            ))}
        </div>
    );
}

function CellView({ c }: { c: Cell }) {
    if (c.kind === "null") return <span className="mm-null">NULL</span>;
    if (c.kind === "binary") return <span className="mm-binary">{c.text}</span>;
    return <>{c.text.length > 200 ? `${c.text.slice(0, 200)}…` : c.text}</>;
}

function Grid({ columns, rows }: { columns: string[]; rows: Cell[][] }) {
    return (
        <div className="table-wrap mm-grid">
            <table className="table">
                <thead><tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
                <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} title={c.text.length > 200 ? c.text : undefined}><CellView c={c} /></td>)}</tr>)}</tbody>
            </table>
        </div>
    );
}

// ---- Browse ---------------------------------------------------------------------------

export interface BrowseRow {
    key: Record<string, string | null> | null;
    cells: Cell[];
}

/** Rows with selection, edit and delete. Without a row key, rows are read-only. */
export function BrowseGrid({ db, table, columns, rows, sortHref, sort, desc, keyColumns }: {
    db: string;
    table: string;
    columns: ColumnInfo[];
    rows: BrowseRow[];
    /** Link for sorting by a column. */
    sortHref: Record<string, string>;
    sort?: string;
    desc?: boolean;
    keyColumns: string[] | null;
}) {
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [state, action] = useActionState(deleteRows.bind(null, db, table), {});
    const router = useRouter();
    useEffect(() => {
        if (state.ok) {
            setSelected(new Set());
            router.refresh();
        }
    }, [state, router]);
    const editable = !!keyColumns;
    const all = rows.length > 0 && selected.size === rows.length;

    return (
        <form action={action} className="stack" style={{ gap: 10 }}>
            {editable && (
                <div className="row">
                    <SubmitButton variant="danger" confirm={`Delete ${selected.size} row${selected.size === 1 ? "" : "s"}? This can't be undone.`}>
                        <Trash2 size={15} aria-hidden /> Delete selected{selected.size ? ` (${selected.size})` : ""}
                    </SubmitButton>
                    {state.message && <span className={state.ok ? "hint" : "notice notice-error"} role="status">{state.message}</span>}
                </div>
            )}
            {!editable && <p className="hint">This table has no primary or unique key, so its rows can&apos;t be edited or deleted here. Add a primary key in Structure, or use SQL.</p>}
            <div className="table-wrap mm-grid">
                <table className="table">
                    <thead>
                        <tr>
                            {editable && (
                                <th scope="col" className="mm-check">
                                    <input type="checkbox" aria-label="Select all rows" checked={all} onChange={() => setSelected(all ? new Set() : new Set(rows.map((_, i) => i)))} />
                                </th>
                            )}
                            {editable && <th scope="col"><span className="sr-only">Edit</span></th>}
                            {columns.map((c) => (
                                <th key={c.name} scope="col">
                                    <a href={sortHref[c.name]} className="mm-sort" title={c.type}>
                                        {c.name}{keyColumns?.includes(c.name) ? " 🔑" : ""}{sort === c.name ? (desc ? " ↓" : " ↑") : ""}
                                    </a>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 && <tr><td colSpan={columns.length + 2} className="hint">No rows.</td></tr>}
                        {rows.map((r, i) => (
                            <tr key={i} className={selected.has(i) ? "mm-selected" : undefined}>
                                {editable && (
                                    <td className="mm-check">
                                        <input type="checkbox" name="row" value={JSON.stringify(r.key)} aria-label={`Select row ${i + 1}`} checked={selected.has(i)}
                                            onChange={() => setSelected((s) => {
                                                const n = new Set(s);
                                                if (n.has(i)) n.delete(i);
                                                else n.add(i);
                                                return n;
                                            })} />
                                    </td>
                                )}
                                {editable && <td className="mm-check"><RowDialog db={db} table={table} columns={columns} rowKey={r.key} cells={r.cells} /></td>}
                                {r.cells.map((c, j) => <td key={j} title={c.text.length > 200 ? c.text : undefined}><CellView c={c} /></td>)}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </form>
    );
}

// ---- Row editor --------------------------------------------------------------------------

/** Edit a row (rowKey set) or insert one. */
export function RowDialog({ db, table, columns, rowKey, cells, trigger = "edit" }: {
    db: string;
    table: string;
    columns: ColumnInfo[];
    rowKey?: Record<string, string | null> | null;
    cells?: Cell[];
    trigger?: "edit" | "insert";
}) {
    const d = useDialog();
    return (
        <>
            {trigger === "edit"
                ? <button type="button" className="btn btn-ghost mm-icon" title="Edit row" aria-label="Edit row" onClick={() => d.setOpen(true)}><Pencil size={14} aria-hidden /></button>
                : <button type="button" className="btn btn-primary" onClick={() => d.setOpen(true)}><Plus size={15} aria-hidden /> Insert row</button>}
            <Dialog d={d} label={rowKey ? "Edit row" : "Insert row"} wide>
                <RowForm db={db} table={table} columns={columns} rowKey={rowKey ?? null} cells={cells} onClose={() => d.setOpen(false)} />
            </Dialog>
        </>
    );
}

function RowForm({ db, table, columns, rowKey, cells, onClose }: {
    db: string; table: string; columns: ColumnInfo[]; rowKey: Record<string, string | null> | null; cells?: Cell[]; onClose: () => void;
}) {
    const [state, action] = useActionState(saveRow.bind(null, db, table, rowKey), {});
    useDone(state, onClose);
    const inserting = !rowKey;
    return (
        <form action={action} className="dialog-body">
            <Head title={inserting ? `Insert into ${table}` : `Edit row in ${table}`} onClose={onClose} />
            <input type="hidden" name="columns" value={JSON.stringify(columns.map((c) => c.name))} />
            <div className="mm-fields">
                {columns.map((c, i) => <FieldRow key={c.name} c={c} i={i} cell={cells?.[i]} inserting={inserting} />)}
            </div>
            {state.message && !state.ok && <p className="notice notice-error" role="alert">{state.message}</p>}
            <div className="row dialog-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                <SubmitButton>{inserting ? "Insert" : "Save"}</SubmitButton>
            </div>
        </form>
    );
}

function FieldRow({ c, i, cell, inserting }: { c: ColumnInfo; i: number; cell?: Cell; inserting: boolean }) {
    const auto = /auto_increment|DEFAULT_GENERATED|VIRTUAL|STORED/i.test(c.extra);
    const [isNull, setNull] = useState(cell ? cell.kind === "null" : false);
    // On insert, columns with a default (or auto values) are left to MySQL unless filled in.
    const [keep, setKeep] = useState(inserting && (auto || c.default !== null || c.nullable));
    const binary = isBinary(c.type);
    const disabled = isNull || keep || binary;
    const value = cell && cell.kind === "value" ? cell.text : "";
    return (
        <div className="mm-field">
            <label htmlFor={`f${i}`} className="mm-field-name">
                <strong>{c.name}</strong>
                <span className="opt">{c.type}{c.key === "PRI" ? " · primary" : ""}{c.extra ? ` · ${c.extra}` : ""}</span>
            </label>
            {binary ? (
                <span className="hint">{cell ? cell.text : "binary"}: kept as it is (use SQL to change binary data)</span>
            ) : isLongText(c.type) ? (
                <textarea id={`f${i}`} name={`v${i}`} defaultValue={value} rows={3} className="env-input" disabled={disabled} spellCheck={false} />
            ) : (
                <input id={`f${i}`} type="text" name={`v${i}`} defaultValue={value} disabled={disabled} spellCheck={false} autoCapitalize="none"
                    placeholder={keep ? (auto ? "automatic" : c.default !== null ? `default: ${c.default}` : "NULL") : ""} />
            )}
            <div className="row mm-field-flags">
                {c.nullable && (
                    <label className="check"><input type="checkbox" name={`n${i}`} checked={isNull} onChange={(e) => { setNull(e.target.checked); if (e.target.checked) setKeep(false); }} /> <span>NULL</span></label>
                )}
                {inserting && (
                    <label className="check"><input type="checkbox" name={`k${i}`} checked={keep} onChange={(e) => { setKeep(e.target.checked); if (e.target.checked) setNull(false); }} /> <span>{auto ? "Automatic" : "Default"}</span></label>
                )}
            </div>
        </div>
    );
}

// ---- Column editor -----------------------------------------------------------------------

export interface ColumnFormValues {
    name: string;
    type: string;
    length: string;
    unsigned: boolean;
    nullable: boolean;
    defaultKind: "none" | "null" | "value" | "current";
    defaultValue: string;
    autoIncrement: boolean;
    comment: string;
    primary?: boolean;
}

/** "varchar(80)", "int unsigned", "enum('a','b')" -> form values. */
export function parseColumn(c: ColumnInfo): ColumnFormValues {
    const m = /^(\w+)(?:\((.*)\))?(\s+unsigned)?/i.exec(c.type);
    const defaultKind: ColumnFormValues["defaultKind"] = c.default === null ? (c.nullable ? "null" : "none") : /^current_timestamp/i.test(c.default) ? "current" : "value";
    return {
        name: c.name, type: (m?.[1] ?? c.type).toUpperCase(), length: m?.[2] ?? "", unsigned: !!m?.[3], nullable: c.nullable,
        defaultKind, defaultValue: defaultKind === "value" ? c.default ?? "" : "", autoIncrement: /auto_increment/i.test(c.extra), comment: c.comment,
    };
}

export function ColumnFields({ v, types, prefix = "", compact = false }: { v?: Partial<ColumnFormValues>; types: string[]; prefix?: string; compact?: boolean }) {
    const [kind, setKind] = useState(v?.defaultKind ?? "none");
    const n = (k: string) => `${prefix}${k}`;
    return (
        <div className={compact ? "mm-col-row" : "stack"} style={compact ? undefined : { gap: 10 }}>
            <div className="mm-col-grid">
                <label>Name<input type="text" name={n("name")} defaultValue={v?.name} required={!compact} spellCheck={false} autoCapitalize="none" /></label>
                <label>Type
                    <select name={n("type")} defaultValue={v?.type ?? "INT"}>
                        {[...new Set([...(v?.type ? [v.type] : []), ...types])].map((t) => <option key={t}>{t}</option>)}
                    </select>
                </label>
                <label><span className="label-text">Length / values <span className="opt">(255, 10,2 or &apos;a&apos;,&apos;b&apos;)</span></span>
                    <input type="text" name={n("length")} defaultValue={v?.length} spellCheck={false} className="mono-input" />
                </label>
                <label>Default
                    <select name={n("defaultKind")} value={kind} onChange={(e) => setKind(e.target.value as ColumnFormValues["defaultKind"])}>
                        <option value="none">None</option>
                        <option value="null">NULL</option>
                        <option value="value">As defined:</option>
                        <option value="current">CURRENT_TIMESTAMP</option>
                    </select>
                </label>
                {kind === "value" && <label>Default value<input type="text" name={n("defaultValue")} defaultValue={v?.defaultValue} spellCheck={false} /></label>}
                {!compact && <label>Comment<input type="text" name={n("comment")} defaultValue={v?.comment} /></label>}
            </div>
            <div className="row mm-field-flags">
                <label className="check"><input type="checkbox" name={n("nullable")} defaultChecked={v?.nullable ?? false} /> <span>Allow NULL</span></label>
                <label className="check"><input type="checkbox" name={n("unsigned")} defaultChecked={v?.unsigned ?? false} /> <span>Unsigned</span></label>
                <label className="check"><input type="checkbox" name={n("ai")} defaultChecked={v?.autoIncrement ?? false} /> <span>Auto increment</span></label>
                {compact && <label className="check"><input type="checkbox" name={n("primary")} defaultChecked={v?.primary ?? false} /> <span>Primary key</span></label>}
            </div>
        </div>
    );
}

/** Add a column (with a position) or change one. */
export function ColumnDialog({ db, table, column, positions, types }: { db: string; table: string; column?: ColumnInfo; positions: string[]; types: string[] }) {
    const d = useDialog();
    return (
        <>
            {column
                ? <button type="button" className="btn btn-ghost mm-icon" title={`Change ${column.name}`} aria-label={`Change ${column.name}`} onClick={() => d.setOpen(true)}><Pencil size={14} aria-hidden /></button>
                : <button type="button" className="btn btn-primary" onClick={() => d.setOpen(true)}><Plus size={15} aria-hidden /> Add column</button>}
            <Dialog d={d} label={column ? `Change ${column.name}` : "Add column"} wide>
                <ColumnForm db={db} table={table} column={column} positions={positions} types={types} onClose={() => d.setOpen(false)} />
            </Dialog>
        </>
    );
}

function ColumnForm({ db, table, column, positions, types, onClose }: { db: string; table: string; column?: ColumnInfo; positions: string[]; types: string[]; onClose: () => void }) {
    const [state, action] = useActionState(saveColumn.bind(null, db, table, column?.name ?? null), {});
    useDone(state, onClose);
    return (
        <form action={action} className="dialog-body">
            <Head title={column ? `Change ${column.name}` : `Add a column to ${table}`} onClose={onClose} />
            <ColumnFields v={column ? parseColumn(column) : undefined} types={types} />
            {!column && (
                <label>Position
                    <select name="position" defaultValue={positions[positions.length - 1] ?? ""}>
                        <option value="__first">First</option>
                        {positions.map((p) => <option key={p} value={p}>After {p}</option>)}
                    </select>
                </label>
            )}
            {state.message && !state.ok && <p className="notice notice-error" role="alert">{state.message}</p>}
            <div className="row dialog-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                <SubmitButton>{column ? "Save" : "Add"}</SubmitButton>
            </div>
        </form>
    );
}

/** Column rows for CREATE TABLE; more can be added before submitting. */
export function TableColumns({ types }: { types: string[] }) {
    const [ids, setIds] = useState([0, 1, 2]);
    const [next, setNext] = useState(3);
    return (
        <div className="stack" style={{ gap: 10 }}>
            <input type="hidden" name="count" value={next} />
            {ids.map((id, i) => (
                <div key={id} className="mm-new-col">
                    <div className="row" style={{ justifyContent: "space-between" }}>
                        <strong className="hint">Column {i + 1}</strong>
                        {ids.length > 1 && <button type="button" className="btn btn-ghost mm-icon" aria-label={`Remove column ${i + 1}`} onClick={() => setIds(ids.filter((x) => x !== id))}><X size={14} aria-hidden /></button>}
                    </div>
                    <ColumnFields types={types} prefix={`c${id}.`} compact
                        v={i === 0 && id === 0 ? { name: "id", type: "INT", unsigned: true, autoIncrement: true, primary: true } : undefined} />
                </div>
            ))}
            <div><button type="button" className="btn btn-secondary" onClick={() => { setIds([...ids, next]); setNext(next + 1); }}><Plus size={15} aria-hidden /> Another column</button></div>
        </div>
    );
}
