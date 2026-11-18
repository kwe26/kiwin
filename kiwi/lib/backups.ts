import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KiwiMysql } from "./mysql";
import { KiwiNginx } from "./nginx";

// Backups of user.img's contents, in /www/backups as .tar.gz (gzip is in the
// system image, zstd isn't). Paths are stored relative to / ("www/sites/..."),
// databases as one SQL dump, plus kiwin-backup.json describing what is inside.

export const BACKUP_DIR = "/www/backups";
const MANIFEST = "kiwin-backup.json";
const SQL = "databases.sql";
const REDIR = "/www/redir.json";
export const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.tar\.gz$/;

export type Part = "websites" | "databases" | "mail" | "apps" | "panel";

export const PARTS: Record<Part, { label: string; about: string; paths: string[] }> = {
    websites: { label: "Websites", about: "Site files, nginx settings and certificates", paths: ["www/sites", "www/nginx"] },
    databases: { label: "Databases", about: "Every MySQL database, as an SQL dump", paths: [] },
    mail: { label: "Mail", about: "Mailboxes, mail domains and webmail settings", paths: ["www/apps/mail", "www/apps/snappymail"] },
    apps: { label: "Apps & services", about: "Data of installed apps, PM2 processes, your services", paths: ["www/apps", "www/services", "www/.pm2"] },
    panel: { label: "Panel settings", about: "Admin account, stored passwords, PHP settings, software list", paths: ["www/db", "www/php", "www/.kiwi", "www/repo.json", "www/redir.json"] },
};

export const PART_IDS = Object.keys(PARTS) as Part[];

/**
 * Never written back: MySQL's own data and the root password that matches the
 * running server (a restore would lock kiwi out of MySQL). Software is
 * reinstalled from the Software page instead.
 */
const NEVER = ["www/db/mysql", "www/db/mysql_password.txt", "www/password.txt", "www/backups", "www/softwares"];

interface Manifest {
    format: 1;
    createdAt: string;
    parts: Part[];
    /** Paths actually in the archive. */
    paths: string[];
    databases: boolean;
}

export interface Backup {
    name: string;
    size: number;
    createdAt: number;
    parts: Part[] | null;
}

const under = (path: string, parent: string) => path === parent || path.startsWith(parent + "/");

function checkName(name: string) {
    if (!BACKUP_NAME.test(name)) throw new Error("Invalid backup name");
    return join(BACKUP_DIR, name);
}

/** Run a command, passing stderr lines to `out`; returns the exit code. */
async function run(cmd: string[], out: (l: string) => void, stdout: "ignore" | "pipe" = "ignore") {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout, stderr: "pipe" });
    const err = new Response(p.stderr).text();
    const code = await p.exited;
    for (const l of (await err).split("\n").filter(Boolean).slice(-20)) out(l);
    return code;
}

async function readManifest(file: string): Promise<Manifest> {
    const p = Bun.spawn(["tar", "-xzOf", file, MANIFEST], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error("This is not a Kiwin backup (no kiwin-backup.json inside)");
    const m = JSON.parse(text) as Manifest;
    if (m.format !== 1 || !Array.isArray(m.paths)) throw new Error("Unknown backup format");
    // Only paths a backup can hold: an uploaded file must not write elsewhere.
    m.paths = m.paths.filter((p) => typeof p === "string" && PART_IDS.some((id) => PARTS[id].paths.some((root) => under(p, root))) && !p.includes(".."));
    return m;
}

/** Which of `paths` the archive has (tar fails on a member it doesn't have). */
async function inArchive(file: string, paths: string[]): Promise<string[]> {
    const p = Bun.spawn(["tar", "-tzf", file], { stdout: "pipe", stderr: "ignore" });
    const found = new Set<string>();
    let buf = "";
    const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) for (const path of paths) if (under(l.replace(/\/$/, ""), path)) found.add(path);
        if (found.size === paths.length) {
            p.kill();
            break;
        }
    }
    await p.exited;
    return paths.filter((x) => found.has(x));
}

const fmtMB = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export class KiwiBackups {
    static list(): Backup[] {
        if (!existsSync(BACKUP_DIR)) return [];
        const out: Backup[] = [];
        for (const name of readdirSync(BACKUP_DIR)) {
            if (!BACKUP_NAME.test(name)) continue;
            try {
                const st = statSync(join(BACKUP_DIR, name));
                if (!st.isFile()) continue;
                out.push({ name, size: st.size, createdAt: st.mtimeMs, parts: this.cachedParts(name) });
            } catch {}
        }
        return out.sort((a, b) => b.createdAt - a.createdAt);
    }

    /** Parts of a backup, from a small sidecar written when it was made or first read. */
    private static cachedParts(name: string): Part[] | null {
        try {
            return JSON.parse(readFileSync(join(BACKUP_DIR, `.${name}.parts`), "utf8"));
        } catch {
            return null;
        }
    }

    static async parts(name: string): Promise<Part[]> {
        const cached = this.cachedParts(name);
        if (cached) return cached;
        const m = await readManifest(checkName(name));
        writeFileSync(join(BACKUP_DIR, `.${name}.parts`), JSON.stringify(m.parts));
        return m.parts;
    }

    static remove(name: string) {
        rmSync(checkName(name), { force: true });
        rmSync(join(BACKUP_DIR, `.${name}.parts`), { force: true });
    }

    /** Where an upload lands; the caller streams the body in, then calls accept(). */
    static uploadTarget(name: string) {
        mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
        const file = checkName(name);
        if (existsSync(file)) throw new Error(`${name} already exists`);
        return { file, tmp: `${file}.uploading` };
    }

    /** Check an uploaded file is a backup before it is listed. */
    static async accept(tmp: string, file: string) {
        try {
            const m = await readManifest(tmp);
            renameSync(tmp, file);
            writeFileSync(join(BACKUP_DIR, `.${file.split("/").pop()}.parts`), JSON.stringify(m.parts));
        } catch (e) {
            rmSync(tmp, { force: true });
            throw e;
        }
    }

    static async create(parts: Part[], out: (l: string) => void): Promise<string> {
        if (parts.length === 0) throw new Error("Choose what to back up");
        mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const name = `kiwin-backup-${stamp}.tar.gz`;
        const file = join(BACKUP_DIR, name);
        const work = join(BACKUP_DIR, `.work-${stamp}`);
        rmSync(work, { recursive: true, force: true });
        mkdirSync(work, { mode: 0o700 });
        try {
            // Each path once: Mail's folders are inside Apps when both are chosen.
            const wanted = [...new Set(parts.flatMap((p) => PARTS[p].paths))];
            const paths = wanted.filter((p) => existsSync(`/${p}`) && !wanted.some((q) => q !== p && under(p, q)));

            let databases = false;
            if (parts.includes("databases")) {
                if (!KiwiMysql.isSetup()) out("Databases: MySQL is not set up, skipped");
                else if ((await KiwiMysql.listDatabases()).length === 0) out("Databases: there are none yet, skipped");
                else {
                    out("Dumping databases");
                    const dump = await KiwiMysql.dump(null);
                    await Bun.write(join(work, SQL), new Response(dump.stdout));
                    const err = await dump.done;
                    if (err) throw new Error(`mysqldump: ${err}`);
                    out(`Databases: ${fmtMB(statSync(join(work, SQL)).size)} of SQL`);
                    databases = true;
                }
            }
            const manifest: Manifest = { format: 1, createdAt: new Date().toISOString(), parts, paths, databases };
            writeFileSync(join(work, MANIFEST), JSON.stringify(manifest, null, 2));

            out(`Packing ${paths.length ? paths.map((p) => `/${p}`).join(", ") : "the databases"}`);
            const code = await run([
                "nice", "-n", "10", "tar", "-czf", `${file}.part`,
                ...NEVER.map((p) => `--exclude=${p}`), "--exclude=www/apps/*/cache", "--warning=no-file-changed",
                "-C", work, MANIFEST, ...(databases ? [SQL] : []),
                ...(paths.length ? ["-C", "/", ...paths] : []),
            ], out);
            // 1: some file changed while it was read (a log, a mailbox): the backup is still usable.
            if (code !== 0 && code !== 1) throw new Error(`tar failed (exit ${code})`);
            renameSync(`${file}.part`, file);
            writeFileSync(join(BACKUP_DIR, `.${name}.parts`), JSON.stringify(parts));
            out(`Saved ${name} (${fmtMB(statSync(file).size)})`);
            return name;
        } catch (e) {
            rmSync(`${file}.part`, { force: true });
            throw e;
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    }

    /**
     * Put the chosen parts back. Files are overwritten, files the backup doesn't
     * have are left alone. Databases in the dump are replaced; others stay.
     */
    static async restore(name: string, parts: Part[], out: (l: string) => void): Promise<void> {
        const file = checkName(name);
        if (parts.length === 0) throw new Error("Choose what to restore");
        out("Reading the backup");
        const m = await readManifest(file);
        const chosen = parts.filter((p) => m.parts.includes(p));
        if (chosen.length === 0) throw new Error("The backup holds none of the chosen parts");

        // Paths in the archive that belong to a chosen part; the rest of a shared
        // folder (Mail inside Apps) is excluded when its own part isn't chosen.
        const roots = chosen.flatMap((p) => PARTS[p].paths);
        const direct = m.paths.filter((p) => roots.some((r) => under(p, r)));
        // A chosen folder inside a bigger one in the archive (Mail inside Apps): only that folder.
        const nested = m.paths.flatMap((p) => roots.filter((r) => r !== p && under(r, p)));
        const members = [...direct, ...(nested.length ? await inArchive(file, nested) : [])];
        const skip = PART_IDS.filter((p) => !chosen.includes(p)).flatMap((p) => PARTS[p].paths).filter((p) => !roots.includes(p) && members.some((r) => under(p, r)));

        if (members.length) {
            const redirBefore = existsSync(REDIR) ? readFileSync(REDIR, "utf8") : null;
            out(`Restoring ${chosen.filter((p) => p !== "databases").map((p) => PARTS[p].label).join(", ")}`);
            const code = await run([
                "tar", "-xzf", file, "-C", "/", "--no-overwrite-dir",
                ...[...NEVER, ...skip].map((p) => `--exclude=${p}`),
                ...members,
            ], out);
            if (code !== 0) throw new Error(`tar failed (exit ${code})`);
            // Secrets listed now (MySQL's among them) stay listed next to the restored ones.
            if (redirBefore) {
                try {
                    const merged = { ...JSON.parse(readFileSync(REDIR, "utf8")), ...JSON.parse(redirBefore) };
                    writeFileSync(REDIR, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
                } catch {
                    writeFileSync(REDIR, redirBefore, { mode: 0o600 });
                }
            }
        }

        if (chosen.includes("databases") && m.databases) {
            if (!KiwiMysql.isSetup()) throw new Error("MySQL is not set up on this server: set it up from Databases, then restore the databases");
            out("Importing databases");
            const p = Bun.spawn(["tar", "-xzOf", file, SQL], { stdout: "pipe", stderr: "pipe" });
            const { bytes } = await KiwiMysql.restore(null, p.stdout as ReadableStream<Uint8Array>);
            if ((await p.exited) !== 0) throw new Error("could not read databases.sql from the backup");
            out(`Databases: imported ${fmtMB(bytes)}`);
        }

        if (chosen.includes("websites")) {
            out("Reloading nginx");
            if (!(await KiwiNginx.reload())) out(`nginx: ${KiwiNginx.lastError ?? "reload failed"}`);
            // Restored PHP sites need their pools here too.
            await KiwiNginx.migratePhpPools();
        }
        out("Restore finished. Restart apps and services from Services or PM2 so they pick up the restored files.");
    }
}
