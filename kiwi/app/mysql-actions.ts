"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/forms";
import { KiwiAuth } from "@/lib/auth";
import { KiwiMysqlAdmin as A, display, isBinaryType } from "@/lib/mysql-admin";
import { requireUser } from "@/lib/session";

// Actions of the MySQL Manager. Every one fails while the Manager is off
// (KiwiMysqlAdmin checks); turning it on takes the master password.

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const ok = (message: string): ActionState => ({ ok: true, message });
const fail = (e: unknown): ActionState => ({ ok: false, message: e instanceof Error ? e.message : String(e) });
const base = (db?: string, table?: string) => `/databases/manager${db ? `/${encodeURIComponent(db)}` : ""}${table ? `/${encodeURIComponent(table)}` : ""}`;

async function attempt(run: () => Promise<string>, paths: string[] = []): Promise<ActionState> {
    await requireUser();
    try {
        const message = await run();
        for (const p of paths) revalidatePath(p);
        return ok(message);
    } catch (e) {
        return fail(e);
    }
}

export async function setMysqlManager(on: boolean, _: ActionState, fd: FormData): Promise<ActionState> {
    const user = await requireUser();
    if (on) {
        const error = await KiwiAuth.verifyPassword(user, s(fd, "password"));
        if (error) return fail(error);
    }
    A.setEnabled(on);
    revalidatePath("/", "layout");
    return ok(on ? "MySQL Manager is on" : "MySQL Manager is off");
}

export interface ConsoleResult {
    sql: string;
    columns: string[];
    rows: { text: string; kind: "null" | "binary" | "value" }[][];
    affected: number | null;
    insertId: number | null;
    ms: number;
    truncated: boolean;
}

const MAX_CONSOLE_ROWS = 1000;

export async function runSql(db: string | null, sql: string): Promise<{ results: ConsoleResult[] } | { error: string }> {
    await requireUser();
    if (!sql.trim()) return { error: "Type a query" };
    try {
        const sets = await A.run(sql, db ?? undefined);
        return {
            results: sets.map((r) => ({
                sql: r.sql, columns: r.columns, affected: r.affected, insertId: r.insertId, ms: r.ms,
                truncated: r.rows.length > MAX_CONSOLE_ROWS,
                rows: r.rows.slice(0, MAX_CONSOLE_ROWS).map((row) => r.columns.map((c) => display(row[c]))),
            })),
        };
    } catch (e) {
        // MySQL stops at the failing statement; the ones before it have run.
        const several = sql.trim().replace(/;\s*$/, "").includes(";");
        return { error: `${(e as Error).message}${several ? " (statements before the failing one have already run)" : ""}` };
    } finally {
        revalidatePath(base(db ?? undefined));
    }
}

// ---- Server ----

export async function createDatabase(_: ActionState, fd: FormData): Promise<ActionState> {
    const name = s(fd, "name").trim();
    const r = await attempt(async () => {
        await A.createDatabase(name, s(fd, "collation") || undefined);
        return `Database ${name} created`;
    }, [base()]);
    if (r.ok) redirect(base(name));
    return r;
}

export async function dropDatabase(name: string, _: ActionState, fd: FormData): Promise<ActionState> {
    if (s(fd, "confirm") !== name) return fail(`Type ${name} to confirm`);
    const r = await attempt(async () => {
        await A.dropDatabase(name);
        return `Database ${name} dropped`;
    }, [base()]);
    if (r.ok) redirect(base());
    return r;
}

export async function killQuery(id: number, _: ActionState, __: FormData): Promise<ActionState> {
    return attempt(async () => {
        await A.kill(id);
        return `Query ${id} killed`;
    }, [base()]);
}

// ---- Tables ----

export interface ColumnInput {
    name: string;
    type: string;
    length: string;
    unsigned: boolean;
    nullable: boolean;
    defaultKind: "none" | "null" | "value" | "current";
    defaultValue: string;
    autoIncrement: boolean;
    primary: boolean;
    comment: string;
}

const columnFrom = (fd: FormData, p = ""): ColumnInput => ({
    name: s(fd, `${p}name`), type: s(fd, `${p}type`), length: s(fd, `${p}length`),
    unsigned: fd.get(`${p}unsigned`) === "on", nullable: fd.get(`${p}nullable`) === "on",
    defaultKind: (["none", "null", "value", "current"].includes(s(fd, `${p}defaultKind`)) ? s(fd, `${p}defaultKind`) : "none") as ColumnInput["defaultKind"],
    defaultValue: s(fd, `${p}defaultValue`), autoIncrement: fd.get(`${p}ai`) === "on", primary: fd.get(`${p}primary`) === "on", comment: s(fd, `${p}comment`),
});

export async function createTable(db: string, _: ActionState, fd: FormData): Promise<ActionState> {
    const table = s(fd, "table").trim();
    const count = Math.min(200, Number(fd.get("count")) || 0);
    const r = await attempt(async () => {
        const cols = Array.from({ length: count }, (_, i) => columnFrom(fd, `c${i}.`)).filter((c) => c.name.trim());
        await A.createTable(db, table, cols.map((c) => A.columnSql(c)), cols.filter((c) => c.primary).map((c) => c.name.trim()), s(fd, "engine") || undefined, s(fd, "collation") || undefined);
        return `Table ${table} created`;
    }, [base(db)]);
    if (r.ok) redirect(`${base(db, table)}?tab=structure`);
    return r;
}

export async function tableOp(db: string, table: string, op: "truncate" | "drop" | "dropView" | "rename" | "copy" | "options", _: ActionState, fd: FormData): Promise<ActionState> {
    let to = "";
    const r = await attempt(async () => {
        switch (op) {
            case "truncate": await A.truncate(db, table); return `${table} emptied`;
            case "drop": await A.dropTable(db, table); return `${table} dropped`;
            case "dropView": await A.dropTable(db, table, true); return `${table} dropped`;
            case "rename":
                to = s(fd, "to").trim();
                if (!to) throw new Error("Give the new name");
                await A.renameTable(db, table, to, s(fd, "toDb") || db);
                return `Renamed to ${to}`;
            case "copy":
                to = s(fd, "to").trim();
                if (!to) throw new Error("Give the copy a name");
                await A.copyTable(db, table, to, fd.get("data") === "on");
                return `Copied to ${to}`;
            case "options":
                await A.tableOptions(db, table, { engine: s(fd, "engine"), collation: s(fd, "collation"), comment: s(fd, "comment"), autoIncrement: s(fd, "autoIncrement") });
                return "Table options saved";
        }
    }, [base(db), base(db, table)]);
    if (r.ok && (op === "drop" || op === "dropView")) redirect(base(db));
    if (r.ok && op === "rename") redirect(`${base(s(fd, "toDb") || db, to)}?tab=operations`);
    return r;
}

// ---- Structure ----

export async function saveColumn(db: string, table: string, from: string | null, _: ActionState, fd: FormData): Promise<ActionState> {
    return attempt(async () => {
        const c = columnFrom(fd);
        const sql = A.columnSql(c);
        if (from) await A.changeColumn(db, table, from, sql);
        else await A.addColumn(db, table, sql, s(fd, "position"));
        return from ? `Column ${c.name} changed` : `Column ${c.name} added`;
    }, [base(db, table)]);
}

export async function dropColumn(db: string, table: string, name: string, _: ActionState, __: FormData): Promise<ActionState> {
    return attempt(async () => {
        await A.dropColumn(db, table, name);
        return `Column ${name} dropped`;
    }, [base(db, table)]);
}

export async function addIndex(db: string, table: string, _: ActionState, fd: FormData): Promise<ActionState> {
    return attempt(async () => {
        const kind = s(fd, "kind") as "PRIMARY" | "UNIQUE" | "INDEX" | "FULLTEXT";
        if (!["PRIMARY", "UNIQUE", "INDEX", "FULLTEXT"].includes(kind)) throw new Error("Choose an index type");
        await A.addIndex(db, table, kind, fd.getAll("columns").map(String), s(fd, "name").trim() || undefined);
        return "Index added";
    }, [base(db, table)]);
}

export async function dropIndex(db: string, table: string, name: string, _: ActionState, __: FormData): Promise<ActionState> {
    return attempt(async () => {
        await A.dropIndex(db, table, name);
        return `Index ${name} dropped`;
    }, [base(db, table)]);
}

export async function addForeignKey(db: string, table: string, _: ActionState, fd: FormData): Promise<ActionState> {
    return attempt(async () => {
        const [refTable, refColumn] = s(fd, "ref").split("\u0000");
        if (!refTable || !refColumn) throw new Error("Choose the referenced column");
        await A.addForeignKey(db, table, s(fd, "column"), refTable, refColumn, s(fd, "onDelete"), s(fd, "onUpdate"));
        return "Foreign key added";
    }, [base(db, table)]);
}

export async function dropForeignKey(db: string, table: string, name: string, _: ActionState, __: FormData): Promise<ActionState> {
    return attempt(async () => {
        await A.dropForeignKey(db, table, name);
        return `Foreign key ${name} dropped`;
    }, [base(db, table)]);
}

// ---- Rows ----

/**
 * Row form: fields v<i> (value), n<i> (NULL) and k<i> (keep / use default) per
 * column index; `columns` is the JSON list of names the form was built for,
 * so a structure change in between can't put values in the wrong column.
 */
export async function saveRow(db: string, table: string, key: Record<string, string | null> | null, _: ActionState, fd: FormData): Promise<ActionState> {
    return attempt(async () => {
        const names = JSON.parse(s(fd, "columns") || "[]") as string[];
        const columns = await A.columns(db, table);
        if (names.length !== columns.length || names.some((n, i) => columns[i].name !== n)) throw new Error("The table changed meanwhile: reload the page");
        const values: Record<string, string | null> = {};
        columns.forEach((c, i) => {
            if (isBinaryType(c.type) && fd.get(`n${i}`) !== "on") return; // binary data is kept as is
            if (fd.get(`k${i}`) === "on") return;
            values[c.name] = fd.get(`n${i}`) === "on" ? null : s(fd, `v${i}`);
        });
        if (key) {
            const n = await A.updateRow(db, table, key, values);
            return n ? "Row saved" : "Nothing changed";
        }
        const id = await A.insertRow(db, table, values);
        return id ? `Row inserted (id ${id})` : "Row inserted";
    }, [base(db, table)]);
}

export async function deleteRows(db: string, table: string, _: ActionState, fd: FormData): Promise<ActionState> {
    return attempt(async () => {
        const keys = fd.getAll("row").map((k) => JSON.parse(String(k)) as Record<string, string | null>);
        if (!keys.length) throw new Error("Select rows first");
        const n = await A.deleteRows(db, table, keys);
        return `${n} row${n === 1 ? "" : "s"} deleted`;
    }, [base(db, table)]);
}
