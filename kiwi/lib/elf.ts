import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Minimal ELF reader for "which shared libraries does this need?" (DT_NEEDED),
// used to check unpacked software for missing libraries. The system image has
// no readelf, and running ldd would run each binary's loader.

/** DT_NEEDED entries of a 64-bit little-endian ELF file, or null if it isn't one. */
export function elfNeeded(file: string): string[] | null {
    let fd: number;
    try {
        fd = openSync(file, "r");
    } catch {
        return null;
    }
    try {
        const read = (pos: number, len: number) => {
            const b = Buffer.alloc(len);
            const n = readSync(fd, b, 0, len, pos);
            return b.subarray(0, n);
        };
        const h = read(0, 64);
        if (h.length < 64 || h.readUInt32BE(0) !== 0x7f454c46 || h[4] !== 2 || h[5] !== 1) return null;
        const phoff = Number(h.readBigUInt64LE(32));
        const phentsize = h.readUInt16LE(54);
        const phnum = h.readUInt16LE(56);
        const loads: { vaddr: number; offset: number; size: number }[] = [];
        let dyn: { offset: number; size: number } | null = null;
        for (let i = 0; i < phnum; i++) {
            const p = read(phoff + i * phentsize, phentsize);
            const type = p.readUInt32LE(0);
            const offset = Number(p.readBigUInt64LE(8));
            const vaddr = Number(p.readBigUInt64LE(16));
            const filesz = Number(p.readBigUInt64LE(32));
            if (type === 1) loads.push({ vaddr, offset, size: filesz }); // PT_LOAD
            if (type === 2) dyn = { offset, size: filesz }; // PT_DYNAMIC
        }
        if (!dyn) return []; // static binary
        const d = read(dyn.offset, dyn.size);
        const needed: number[] = [];
        let strtab = -1;
        for (let o = 0; o + 16 <= d.length; o += 16) {
            const tag = Number(d.readBigInt64LE(o));
            const val = Number(d.readBigUInt64LE(o + 8));
            if (tag === 0) break;
            if (tag === 1) needed.push(val); // DT_NEEDED
            if (tag === 5) strtab = val; // DT_STRTAB (a virtual address)
        }
        const seg = loads.find((l) => strtab >= l.vaddr && strtab < l.vaddr + l.size);
        if (!seg) return [];
        const base = seg.offset + (strtab - seg.vaddr);
        return needed.map((off) => {
            const s = read(base + off, 256);
            const end = s.indexOf(0);
            return s.subarray(0, end < 0 ? s.length : end).toString("latin1");
        });
    } finally {
        closeSync(fd);
    }
}

function* files(dir: string): Generator<string> {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) yield* files(p);
        else if (e.isFile()) yield p;
    }
}

/** Every shared library file name under these trees (wherever it sits: plugins find theirs by rpath). */
function libraryNames(trees: string[]): Set<string> {
    const names = new Set<string>();
    for (const t of trees) {
        for (const f of files(t)) if (f.includes(".so")) names.add(basename(f));
        // Symlinked sonames (libfoo.so.1 -> libfoo.so.1.2.3) are files too, but readdir's isFile skips links.
        try {
            for (const f of walkLinks(t)) names.add(basename(f));
        } catch {}
    }
    return names;
}

function* walkLinks(dir: string): Generator<string> {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) yield* walkLinks(p);
        else if (e.isSymbolicLink() && e.name.includes(".so")) yield p;
    }
}

export interface MissingLibrary {
    soname: string;
    /** Files that need it (relative to the scanned directory), a few at most. */
    neededBy: string[];
}

/**
 * Libraries needed by ELF files under `dir` that are found neither in the
 * system's library directories nor anywhere under `dir` or `extraTrees`.
 */
export function missingLibraries(dir: string, extraTrees: string[] = []): MissingLibrary[] {
    const system = ["/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib64", "/usr/lib64", "/lib", "/usr/lib"];
    const available = libraryNames([dir, ...extraTrees]);
    const missing = new Map<string, string[]>();
    for (const f of files(dir)) {
        try {
            if (lstatSync(f).size < 64) continue;
        } catch {
            continue;
        }
        const needed = elfNeeded(f);
        if (!needed) continue;
        for (const lib of needed) {
            if (available.has(lib) || existsSync(join(dirname(f), lib)) || system.some((s) => existsSync(join(s, lib)))) continue;
            const by = missing.get(lib) ?? [];
            if (by.length < 3) by.push(f.slice(dir.length + 1));
            missing.set(lib, by);
        }
    }
    return [...missing].map(([soname, neededBy]) => ({ soname, neededBy }));
}

/**
 * Debian package names that usually ship a soname: libavahi-common.so.3 ->
 * libavahi-common3, libgtk-3.so.0 -> libgtk-3-0, libcups.so.2 -> libcups2t64.
 */
export function packageCandidates(soname: string): string[] {
    const m = /^(.+?)\.so(?:\.(\d+))?/.exec(soname);
    if (!m) return [];
    const name = m[1].toLowerCase().replace(/_/g, "-");
    const ver = m[2];
    if (!ver) return [name, `${name}0`];
    const sep = /\d$/.test(name) ? "-" : "";
    return [`${name}${sep}${ver}`, `${name}${sep}${ver}t64`, `${name}-${ver}`, `${name}-${ver}t64`, `${name}${ver}`, `${name}${ver}t64`];
}
