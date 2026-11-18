import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

// File manager backend. kiwi runs as root inside the isolation, so this can
// reach the whole isolated system; /www is the user's storage.

export const HOME = "/www";
const MAX_EDIT = 2 * 1024 * 1024;
const MAX_ENTRIES = 5000;

/** Paths that must not be deleted or renamed from the panel. */
const PROTECTED = new Set([
    "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/media", "/mnt", "/opt", "/proc", "/root", "/run",
    "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var", "/mount", "/mount/www",
    "/www", "/www/db", "/www/db/mysql", "/www/nginx", "/www/sites", "/www/password.txt", "/www/redir.json",
]);

export interface Entry {
    name: string;
    path: string;
    type: "dir" | "file" | "link" | "other";
    size: number;
    mtime: number;
    mode: string;
    target?: string;
}

/** Normalise to an absolute path without "..". */
export function clean(path: string): string {
    return posix.resolve("/", path || HOME);
}

function checkName(name: string): string {
    const n = name.trim();
    if (!n || n === "." || n === ".." || n.includes("/") || n.includes("\0") || n.length > 255) throw new Error("Invalid name");
    return n;
}

function modeString(mode: number): string {
    const chars = "rwxrwxrwx";
    let s = "";
    for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : "-";
    return s;
}

export class KiwiFiles {
    static list(path: string): Entry[] {
        const dir = clean(path);
        const names = readdirSync(dir).slice(0, MAX_ENTRIES);
        const entries: Entry[] = [];
        for (const name of names) {
            const full = join(dir, name);
            try {
                const st = lstatSync(full);
                const type = st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSymbolicLink() ? "link" : "other";
                const entry: Entry = { name, path: full, type, size: st.size, mtime: st.mtimeMs, mode: modeString(st.mode) };
                if (type === "link") {
                    entry.target = readlinkSync(full);
                    try {
                        if (statSync(full).isDirectory()) entry.type = "dir"; // follow links to directories when browsing
                    } catch {}
                }
                entries.push(entry);
            } catch {}
        }
        return entries.sort((a, b) => (a.type === "dir") !== (b.type === "dir") ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name));
    }

    static isDir(path: string): boolean {
        try {
            return statSync(clean(path)).isDirectory();
        } catch {
            return false;
        }
    }

    /** Text content for the editor, or why it can't be edited. */
    static readText(path: string): { content: string } | { error: string; size?: number } {
        const file = clean(path);
        let st;
        try {
            st = statSync(file);
        } catch {
            return { error: "File not found" };
        }
        if (!st.isFile()) return { error: "Not a regular file" };
        if (st.size > MAX_EDIT) return { error: "File is too large to edit here; download it instead", size: st.size };
        // Binary if the first 8 KB contain a NUL byte.
        const fd = openSync(file, "r");
        const head = Buffer.alloc(Math.min(8192, st.size));
        readSync(fd, head, 0, head.length, 0);
        closeSync(fd);
        if (head.includes(0)) return { error: "Binary file; download it instead", size: st.size };
        return { content: readFileSync(file, "utf8") };
    }

    static writeText(path: string, content: string): void {
        const file = clean(path);
        if (!statSync(file).isFile()) throw new Error("Not a regular file");
        writeFileSync(file, content);
    }

    static mkdir(dir: string, name: string): string {
        const target = join(clean(dir), checkName(name));
        mkdirSync(target);
        return target;
    }

    static touch(dir: string, name: string): string {
        const target = join(clean(dir), checkName(name));
        writeFileSync(target, "", { flag: "wx", mode: 0o644 });
        return target;
    }

    static rename(path: string, newName: string): string {
        const from = clean(path);
        if (PROTECTED.has(from)) throw new Error(`${from} is protected`);
        const to = join(dirname(from), checkName(newName));
        try {
            lstatSync(to);
            throw new Error(`${posix.basename(to)} already exists`);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        renameSync(from, to);
        return to;
    }

    static remove(path: string): void {
        const target = clean(path);
        if (PROTECTED.has(target)) throw new Error(`${target} is protected`);
        rmSync(target, { recursive: true });
    }

    static async upload(dir: string, file: File): Promise<string> {
        const target = join(clean(dir), checkName(file.name));
        await Bun.write(target, file);
        return target;
    }
}
