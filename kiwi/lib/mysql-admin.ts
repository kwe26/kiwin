import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { SQL } from "bun";
import { KiwiMysql } from "./mysql";

// The MySQL Manager (phpMyAdmin-like). Off until enabled in the panel. It
// talks to MySQL as root over 127.0.0.1:3306 (where kiwi's MySQL listens):
// Bun's driver can't complete MySQL 8's caching_sha2 login over the unix
// socket. Names are always quoted with ident(), values always bound.
// KIWI_MYSQL_URL (mysql://user:pass@host:port) points it elsewhere in development.

const SETTINGS_DIR = "/www/.kiwi";
const SETTINGS = `${SETTINGS_DIR}/settings.json`;
export const SYSTEM_SCHEMAS = ["information_schema", "mysql", "performance_schema", "sys"];
export const PAGE_SIZES = [25, 50, 100, 250];

export type Row = Record<string, unknown>;

/**
 * Bun's driver sets every session to UTC. Undo that, so NOW() and TIMESTAMP
 * columns mean here what they mean to the apps using the database.
 */
const SERVER_TIME_ZONE = "SET time_zone = @@global.time_zone";

export interface Column {
    name: string;
    type: string;
    collation: string | null;
    nullable: boolean;
    key: string;
    default: string | null;
    extra: string;
    comment: string;
}

export interface QueryResult {
    sql: string;
    columns: string[];
    rows: Row[];
    affected: number | null;
    insertId: number | null;
    ms: number;
}

/** Back-quote an identifier (`a``b`). */
export const ident = (name: string) => `\`${name.replace(/`/g, "``")}\``;

const isSystem = (db: string) => SYSTEM_SCHEMAS.includes(db.toLowerCase());

const g = globalThis as unknown as { __kiwiMysqlAdmin?: { db: SQL; key: string } };

function readSettings(): Record<string, unknown> {
    try {
        return JSON.parse(readFileSync(SETTINGS, "utf8"));
    } catch {
        return {};
    }
}

function writeSettings(s: Record<string, unknown>) {
    mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${SETTINGS}.tmp`, SETTINGS);
}

async function pool(): Promise<SQL> {
    const url = process.env.KIWI_MYSQL_URL;
    const opts = url
        ? (() => {
            const u = new URL(url);
            return { hostname: u.hostname, port: Number(u.port || 3306), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
        })()
        : { hostname: "127.0.0.1", port: 3306, username: "root", password: await KiwiMysql.rootPassword() };
    // A changed root password needs a new pool.
    const key = `${opts.hostname}:${opts.port}:${opts.username}:${opts.password}`;
    if (g.__kiwiMysqlAdmin?.key === key) return g.__kiwiMysqlAdmin.db;
    await g.__kiwiMysqlAdmin?.db.close().catch(() => {});
    // Loopback only, so fetching the server's RSA key for the login is safe.
    const db = new SQL({ adapter: "mysql", ...opts, max: 4, idleTimeout: 60, allowPublicKeyRetrieval: true });
    g.__kiwiMysqlAdmin = { db, key };
    return db;
}

/** Plain values for the page: dates as MySQL writes them, binary as a size and hex preview. */
export function display(v: unknown): { text: string; kind: "null" | "binary" | "value" } {
    if (v === null || v === undefined) return { text: "NULL", kind: "null" };
    if (v instanceof Uint8Array) {
        const hex = Buffer.from(v.subarray(0, 16)).toString("hex");
        return { text: `[${v.length} B] 0x${hex}${v.length > 16 ? "…" : ""}`, kind: "binary" };
    }
    if (v instanceof Date) return { text: v.toISOString().replace("T", " ").replace(/(\.000)?Z$/, ""), kind: "value" };
    if (typeof v === "object") return { text: JSON.stringify(v), kind: "value" };
    return { text: String(v), kind: "value" };
}

const TEMPORAL = /^(datetime|timestamp|date|time|year)\b/i;
const BINARY = /^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit|geometry|point|linestring|polygon)/i;

export const isBinaryType = (type: string) => BINARY.test(type);

export class KiwiMysqlAdmin {
    static enabled(): boolean {
        return readSettings().mysqlManager === true;
    }

    static setEnabled(on: boolean) {
        writeSettings({ ...readSettings(), mysqlManager: on });
    }

    private static guard() {
        if (!this.enabled()) throw new Error("The MySQL Manager is turned off. Turn it on from Databases.");
    }

    private static writable(db: string) {
        if (isSystem(db)) throw new Error(`${db} is MySQL's own database: it is read-only here`);
    }

    /** One statement or several (split by MySQL): every result set, in order. */
    static async run(sql: string, database?: string): Promise<QueryResult[]> {
        this.guard();
        const db = await pool();
        const started = performance.now();
        // A reserved connection, so USE applies to the statements that follow it.
        const conn = await db.reserve();
        try {
            await conn.unsafe(SERVER_TIME_ZONE);
            if (database) await conn.unsafe(`USE ${ident(database)}`);
            const raw = await conn.unsafe(sql);
            const ms = Math.round(performance.now() - started);
            const sets = Array.isArray(raw[0]) ? (raw as unknown as Row[][]) : [raw as unknown as Row[]];
            return sets.map((rows, i) => {
                const meta = rows as unknown as { affectedRows?: number; lastInsertRowid?: number | bigint };
                const isRows = rows.length > 0 || /^\s*(select|show|describe|desc|explain|with|values|table)\b/i.test(sql.split(";")[i] ?? "");
                return {
                    sql: (sql.split(";")[i] ?? sql).trim(),
                    columns: rows.length ? Object.keys(rows[0]) : [],
                    rows: [...rows],
                    affected: isRows ? null : meta.affectedRows ?? 0,
                    insertId: meta.lastInsertRowid ? Number(meta.lastInsertRowid) : null,
                    ms,
                };
            });
        } finally {
            conn.release();
        }
    }

    private static async q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
        return [...(await this.exec(sql, params))] as T[];
    }

    /** On a connection set to the server's own time zone (see SERVER_TIME_ZONE). */
    private static async exec(sql: string, params: unknown[] = []) {
        this.guard();
        const conn = await (await pool()).reserve();
        try {
            await conn.unsafe(SERVER_TIME_ZONE);
            return await conn.unsafe(sql, params);
        } finally {
            conn.release();
        }
    }

    // ---- Server ----

    static async server() {
        const [v] = await this.q<{ version: string; uptime: string; charset: string; collation: string }>(
            "SELECT VERSION() AS version, (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime') AS uptime, @@character_set_server AS charset, @@collation_server AS collation",
        );
        return v;
    }

    static async databases() {
        return this.q<{ name: string; tables: number; bytes: string | null; collation: string }>(`
            SELECT s.SCHEMA_NAME AS name, s.DEFAULT_COLLATION_NAME AS collation,
                   COUNT(t.TABLE_NAME) AS tables, SUM(t.DATA_LENGTH + t.INDEX_LENGTH) AS bytes
            FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
            GROUP BY s.SCHEMA_NAME, s.DEFAULT_COLLATION_NAME ORDER BY s.SCHEMA_NAME`);
    }

    static async collations() {
        return (await this.q<{ c: string }>("SELECT COLLATION_NAME AS c FROM information_schema.COLLATIONS WHERE CHARACTER_SET_NAME IN ('utf8mb4','utf8mb3','latin1','ascii','binary') ORDER BY COLLATION_NAME")).map((r) => r.c);
    }

    static async engines() {
        return (await this.q<{ e: string }>("SELECT ENGINE AS e FROM information_schema.ENGINES WHERE SUPPORT IN ('YES','DEFAULT') ORDER BY ENGINE")).map((r) => r.e);
    }

    static async processes() {
        return this.q<{ Id: number; User: string; Host: string; db: string | null; Command: string; Time: number; State: string | null; Info: string | null }>("SHOW FULL PROCESSLIST");
    }

    static async kill(id: number) {
        await this.q(`KILL ${Math.floor(id)}`);
    }

    static async createDatabase(name: string, collation?: string) {
        if (!name.trim() || name.length > 64) throw new Error("Database names are 1 to 64 characters");
        if (collation && !/^[a-z0-9_]+$/i.test(collation)) throw new Error("Invalid collation");
        await this.q(`CREATE DATABASE ${ident(name)}${collation ? ` CHARACTER SET ${collation.split("_")[0]} COLLATE ${collation}` : ""}`);
    }

    static async dropDatabase(name: string) {
        this.writable(name);
        await this.q(`DROP DATABASE ${ident(name)}`);
    }

    // ---- Database ----

    static async exists(db: string, table?: string): Promise<boolean> {
        const rows = table
            ? await this.q("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [db, table])
            : await this.q("SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [db]);
        return rows.length > 0;
    }

    static async tables(db: string) {
        return this.q<{ name: string; type: string; engine: string | null; rows: number | null; bytes: number | null; collation: string | null; comment: string; autoIncrement: number | null }>(`
            SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS \`rows\`, DATA_LENGTH + INDEX_LENGTH AS bytes,
                   TABLE_COLLATION AS collation, TABLE_COMMENT AS comment, AUTO_INCREMENT AS autoIncrement
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]);
    }

    // ---- Table ----

    static async columns(db: string, table: string): Promise<Column[]> {
        const rows = await this.q<Record<string, string | null>>(`SHOW FULL COLUMNS FROM ${ident(db)}.${ident(table)}`);
        return rows.map((r) => ({
            name: r.Field!, type: r.Type!, collation: r.Collation, nullable: r.Null === "YES",
            key: r.Key ?? "", default: r.Default, extra: r.Extra ?? "", comment: r.Comment ?? "",
        }));
    }

    static async indexes(db: string, table: string) {
        const rows = await this.q<{ Key_name: string; Non_unique: number; Column_name: string; Seq_in_index: number; Index_type: string }>(`SHOW INDEX FROM ${ident(db)}.${ident(table)}`);
        const by = new Map<string, { name: string; unique: boolean; type: string; columns: string[] }>();
        for (const r of rows) {
            const i = by.get(r.Key_name) ?? { name: r.Key_name, unique: Number(r.Non_unique) === 0, type: r.Index_type, columns: [] };
            i.columns[r.Seq_in_index - 1] = r.Column_name;
            by.set(r.Key_name, i);
        }
        return [...by.values()];
    }

    static async foreignKeys(db: string, table: string) {
        return this.q<{ name: string; column: string; refTable: string; refColumn: string; onDelete: string; onUpdate: string }>(`
            SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS \`column\`, k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refColumn,
                   r.DELETE_RULE AS onDelete, r.UPDATE_RULE AS onUpdate
            FROM information_schema.KEY_COLUMN_USAGE k
            JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
            WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [db, table]);
    }

    /** Every column of every table in a database (for picking foreign key targets). */
    static async allColumns(db: string) {
        return this.q<{ table: string; column: string }>("SELECT TABLE_NAME AS `table`, COLUMN_NAME AS `column` FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", [db]);
    }

    static async createStatement(db: string, table: string): Promise<string> {
        const [r] = await this.q<Record<string, string>>(`SHOW CREATE TABLE ${ident(db)}.${ident(table)}`);
        return r["Create Table"] ?? r["Create View"] ?? "";
    }

    /** Columns that identify a row: the primary key, else the first unique key without NULLs, else none. */
    static async rowKey(db: string, table: string, columns?: Column[]): Promise<string[] | null> {
        const idx = await this.indexes(db, table);
        const cols = columns ?? (await this.columns(db, table));
        const pk = idx.find((i) => i.name === "PRIMARY");
        if (pk) return pk.columns;
        const uq = idx.find((i) => i.unique && i.columns.every((c) => !cols.find((x) => x.name === c)?.nullable));
        return uq?.columns ?? null;
    }

    /**
     * A page of rows. Temporal columns come back as text, exactly as stored.
     * `where` is a raw SQL condition typed by the admin (it's their database).
     */
    static async browse(db: string, table: string, opts: { page: number; size: number; sort?: string; desc?: boolean; where?: string }) {
        const columns = await this.columns(db, table);
        const size = PAGE_SIZES.includes(opts.size) ? opts.size : 25;
        const page = Math.max(1, Math.floor(opts.page) || 1);
        const sort = columns.find((c) => c.name === opts.sort)?.name;
        const list = columns.map((c) => (TEMPORAL.test(c.type) ? `CAST(${ident(c.name)} AS CHAR) AS ${ident(c.name)}` : ident(c.name))).join(", ");
        const where = opts.where?.trim() ? ` WHERE ${opts.where}` : "";
        const from = `${ident(db)}.${ident(table)}${where}`;
        const [count] = await this.q<{ n: string }>(`SELECT COUNT(*) AS n FROM ${from}`);
        const rows = await this.q(`SELECT ${list} FROM ${from}${sort ? ` ORDER BY ${ident(sort)} ${opts.desc ? "DESC" : "ASC"}` : ""} LIMIT ${size} OFFSET ${(page - 1) * size}`);
        return { columns, rows, total: Number(count.n), page, size, key: await this.rowKey(db, table, columns) };
    }

    /** The row as stored, found by its key values (sent back by the page). */
    static async row(db: string, table: string, key: Record<string, string | null>) {
        const columns = await this.columns(db, table);
        const list = columns.map((c) => (TEMPORAL.test(c.type) ? `CAST(${ident(c.name)} AS CHAR) AS ${ident(c.name)}` : ident(c.name))).join(", ");
        const { sql, params } = this.match(key);
        const [row] = await this.q(`SELECT ${list} FROM ${ident(db)}.${ident(table)} WHERE ${sql} LIMIT 1`, params);
        return { columns, row: row ?? null };
    }

    private static match(key: Record<string, string | null>) {
        const names = Object.keys(key);
        if (names.length === 0) throw new Error("This table has no primary or unique key, so rows can't be told apart: add a primary key first");
        return {
            sql: names.map((k) => (key[k] === null ? `${ident(k)} IS NULL` : `${ident(k)} = ?`)).join(" AND "),
            params: names.filter((k) => key[k] !== null).map((k) => key[k]),
        };
    }

    /** values: column -> text, or null for NULL; columns left out keep their value (or default on insert). */
    static async insertRow(db: string, table: string, values: Record<string, string | null>) {
        this.writable(db);
        const names = Object.keys(values);
        const sql = names.length
            ? `INSERT INTO ${ident(db)}.${ident(table)} (${names.map(ident).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
            : `INSERT INTO ${ident(db)}.${ident(table)} () VALUES ()`;
        const r = (await this.exec(sql, names.map((n) => values[n]))) as unknown as { lastInsertRowid?: number };
        return r.lastInsertRowid ? Number(r.lastInsertRowid) : null;
    }

    static async updateRow(db: string, table: string, key: Record<string, string | null>, values: Record<string, string | null>) {
        this.writable(db);
        const names = Object.keys(values);
        if (!names.length) return 0;
        const m = this.match(key);
        const r = (await this.exec(
            `UPDATE ${ident(db)}.${ident(table)} SET ${names.map((n) => `${ident(n)} = ?`).join(", ")} WHERE ${m.sql} LIMIT 1`,
            [...names.map((n) => values[n]), ...m.params],
        )) as unknown as { affectedRows?: number };
        return r.affectedRows ?? 0;
    }

    static async deleteRows(db: string, table: string, keys: Record<string, string | null>[]) {
        this.writable(db);
        let n = 0;
        for (const key of keys) {
            const m = this.match(key);
            const r = (await this.exec(`DELETE FROM ${ident(db)}.${ident(table)} WHERE ${m.sql} LIMIT 1`, m.params)) as unknown as { affectedRows?: number };
            n += r.affectedRows ?? 0;
        }
        return n;
    }

    // ---- Structure ----

    /** "name TYPE [NULL|NOT NULL] [DEFAULT ...] [AUTO_INCREMENT] [COMMENT ...]" from a column form. */
    static columnSql(c: { name: string; type: string; length?: string; unsigned?: boolean; nullable: boolean; defaultKind: "none" | "null" | "value" | "current"; defaultValue?: string; autoIncrement?: boolean; comment?: string; collation?: string }) {
        if (!c.name.trim()) throw new Error("Give the column a name");
        if (!/^[a-z][a-z0-9 ]*$/i.test(c.type)) throw new Error("Choose a column type");
        const len = c.length?.trim();
        // Lengths like 255, 10,2 or 'a','b' (ENUM/SET values).
        if (len && !/^(\d+(\s*,\s*\d+)?|'([^'\\]|\\.|'')*'(\s*,\s*'([^'\\]|\\.|'')*')*)$/.test(len)) throw new Error(`"${len}" is not a valid length or value list`);
        let sql = `${ident(c.name.trim())} ${c.type.toUpperCase()}${len ? `(${len})` : ""}${c.unsigned ? " UNSIGNED" : ""}`;
        if (c.collation && /^[a-z0-9_]+$/i.test(c.collation)) sql += ` COLLATE ${c.collation}`;
        sql += c.nullable ? " NULL" : " NOT NULL";
        if (c.defaultKind === "null") sql += " DEFAULT NULL";
        if (c.defaultKind === "current") sql += " DEFAULT CURRENT_TIMESTAMP";
        if (c.defaultKind === "value") sql += ` DEFAULT ${literal(c.defaultValue ?? "")}`;
        if (c.autoIncrement) sql += " AUTO_INCREMENT";
        if (c.comment) sql += ` COMMENT ${literal(c.comment)}`;
        return sql;
    }

    static async alter(db: string, table: string, clause: string) {
        this.writable(db);
        await this.q(`ALTER TABLE ${ident(db)}.${ident(table)} ${clause}`);
    }

    static async addColumn(db: string, table: string, columnSql: string, position: string) {
        const pos = position === "__first" ? " FIRST" : position ? ` AFTER ${ident(position)}` : "";
        await this.alter(db, table, `ADD COLUMN ${columnSql}${pos}`);
    }

    static async changeColumn(db: string, table: string, from: string, columnSql: string) {
        await this.alter(db, table, `CHANGE COLUMN ${ident(from)} ${columnSql}`);
    }

    static async dropColumn(db: string, table: string, name: string) {
        await this.alter(db, table, `DROP COLUMN ${ident(name)}`);
    }

    static async addIndex(db: string, table: string, kind: "PRIMARY" | "UNIQUE" | "INDEX" | "FULLTEXT", columns: string[], name?: string) {
        if (!columns.length) throw new Error("Choose at least one column");
        const cols = columns.map(ident).join(", ");
        await this.alter(db, table, kind === "PRIMARY" ? `ADD PRIMARY KEY (${cols})` : `ADD ${kind === "INDEX" ? "INDEX" : `${kind} INDEX`}${name ? ` ${ident(name)}` : ""} (${cols})`);
    }

    static async dropIndex(db: string, table: string, name: string) {
        await this.alter(db, table, name === "PRIMARY" ? "DROP PRIMARY KEY" : `DROP INDEX ${ident(name)}`);
    }

    static async addForeignKey(db: string, table: string, column: string, refTable: string, refColumn: string, onDelete: string, onUpdate: string) {
        const rule = (r: string) => (["RESTRICT", "CASCADE", "SET NULL", "NO ACTION"].includes(r) ? r : "RESTRICT");
        await this.alter(db, table, `ADD FOREIGN KEY (${ident(column)}) REFERENCES ${ident(refTable)} (${ident(refColumn)}) ON DELETE ${rule(onDelete)} ON UPDATE ${rule(onUpdate)}`);
    }

    static async dropForeignKey(db: string, table: string, name: string) {
        await this.alter(db, table, `DROP FOREIGN KEY ${ident(name)}`);
    }

    static async createTable(db: string, table: string, columnSqls: string[], primary: string[], engine?: string, collation?: string) {
        this.writable(db);
        if (!table.trim()) throw new Error("Give the table a name");
        if (!columnSqls.length) throw new Error("Add at least one column");
        const parts = [...columnSqls, ...(primary.length ? [`PRIMARY KEY (${primary.map(ident).join(", ")})`] : [])];
        const opts = `${engine && /^\w+$/.test(engine) ? ` ENGINE=${engine}` : ""}${collation && /^\w+$/.test(collation) ? ` COLLATE=${collation}` : ""}`;
        await this.q(`CREATE TABLE ${ident(db)}.${ident(table.trim())} (\n  ${parts.join(",\n  ")}\n)${opts}`);
    }

    // ---- Operations ----

    static async renameTable(db: string, table: string, to: string, toDb = db) {
        this.writable(db);
        this.writable(toDb);
        await this.q(`RENAME TABLE ${ident(db)}.${ident(table)} TO ${ident(toDb)}.${ident(to)}`);
    }

    static async copyTable(db: string, table: string, to: string, withData: boolean) {
        this.writable(db);
        await this.q(`CREATE TABLE ${ident(db)}.${ident(to)} LIKE ${ident(db)}.${ident(table)}`);
        if (withData) await this.q(`INSERT INTO ${ident(db)}.${ident(to)} SELECT * FROM ${ident(db)}.${ident(table)}`);
    }

    static async tableOptions(db: string, table: string, opts: { engine?: string; collation?: string; comment?: string; autoIncrement?: string }) {
        const parts: string[] = [];
        if (opts.engine && /^\w+$/.test(opts.engine)) parts.push(`ENGINE=${opts.engine}`);
        if (opts.collation && /^\w+$/.test(opts.collation)) parts.push(`CONVERT TO CHARACTER SET ${opts.collation.split("_")[0]} COLLATE ${opts.collation}`);
        if (opts.comment !== undefined) parts.push(`COMMENT=${literal(opts.comment)}`);
        if (opts.autoIncrement && /^\d+$/.test(opts.autoIncrement)) parts.push(`AUTO_INCREMENT=${opts.autoIncrement}`);
        if (parts.length) await this.alter(db, table, parts.join(", "));
    }

    static async truncate(db: string, table: string) {
        this.writable(db);
        await this.q(`TRUNCATE TABLE ${ident(db)}.${ident(table)}`);
    }

    static async dropTable(db: string, table: string, view = false) {
        this.writable(db);
        await this.q(`DROP ${view ? "VIEW" : "TABLE"} ${ident(db)}.${ident(table)}`);
    }

    /** Whole table as CSV, streamed page by page so big tables don't sit in memory. */
    static csv(db: string, table: string): ReadableStream<Uint8Array> {
        const enc = new TextEncoder();
        const cell = (v: unknown) => {
            if (v === null || v === undefined) return "";
            const s = v instanceof Uint8Array ? `0x${Buffer.from(v).toString("hex")}` : display(v).text;
            return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        let offset = 0;
        let columns: Column[] | null = null;
        return new ReadableStream({
            pull: async (controller) => {
                try {
                    if (!columns) {
                        columns = await this.columns(db, table);
                        controller.enqueue(enc.encode(columns.map((c) => cell(c.name)).join(",") + "\r\n"));
                    }
                    const list = columns.map((c) => (TEMPORAL.test(c.type) ? `CAST(${ident(c.name)} AS CHAR) AS ${ident(c.name)}` : ident(c.name))).join(", ");
                    const rows = await this.q(`SELECT ${list} FROM ${ident(db)}.${ident(table)} LIMIT 2000 OFFSET ${offset}`);
                    offset += rows.length;
                    if (rows.length) controller.enqueue(enc.encode(rows.map((r) => columns!.map((c) => cell(r[c.name])).join(",")).join("\r\n") + "\r\n"));
                    if (rows.length < 2000) controller.close();
                } catch (e) {
                    controller.error(e);
                }
            },
        });
    }

    /** mysqldump of one table, through the existing client setup (password never on the command line). */
    static async dumpTable(db: string, table: string) {
        this.guard();
        return KiwiMysql.dumpTable(db, table);
    }

    static settingsExist() {
        return existsSync(SETTINGS);
    }
}

/** A quoted SQL string literal. */
function literal(s: string) {
    return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export const COLUMN_TYPES = [
    "INT", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT", "DECIMAL", "FLOAT", "DOUBLE", "BIT", "BOOLEAN",
    "VARCHAR", "CHAR", "TEXT", "TINYTEXT", "MEDIUMTEXT", "LONGTEXT", "ENUM", "SET", "JSON",
    "DATE", "DATETIME", "TIMESTAMP", "TIME", "YEAR",
    "BINARY", "VARBINARY", "BLOB", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB",
    "GEOMETRY", "POINT",
];
