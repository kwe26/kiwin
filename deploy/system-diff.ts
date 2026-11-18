// Used by Upgrade.sh: what a user added to the old system image, so it can be
// carried over to a newer one. Both images are mounted; root inside the
// isolation controls the old one, so nothing in it is trusted as a path.
//
//   bun system-diff.ts packages <old-root> <new-root>   packages to reinstall, one per line
//   bun system-diff.ts carry <old-root> <new-root>      copy edited config files and extra units
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

interface Pkg {
    name: string;
    arch: string;
    /** Absolute path -> md5 the package shipped. */
    conffiles: Map<string, string>;
}

function installed(root: string): Map<string, Pkg> {
    const out = new Map<string, Pkg>();
    const text = readFileSync(join(root, "var/lib/dpkg/status"), "utf8");
    for (const block of text.split("\n\n")) {
        const field = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(block)?.[1]?.trim();
        const name = field("Package");
        if (!name || !/\binstall ok installed\b/.test(field("Status") ?? "")) continue;
        const conffiles = new Map<string, string>();
        const m = /^Conffiles:\n((?: .*\n?)+)/m.exec(block);
        for (const line of m?.[1].split("\n") ?? []) {
            const [path, md5, flag] = line.trim().split(/\s+/);
            if (path && md5 && flag !== "obsolete" && flag !== "remove-on-upgrade") conffiles.set(path, md5);
        }
        out.set(name, { name, arch: field("Architecture") ?? "", conffiles });
    }
    return out;
}

/** Packages apt installed only as dependencies (they come back with whatever needs them). */
function automatic(root: string): Set<string> {
    const auto = new Set<string>();
    try {
        for (const block of readFileSync(join(root, "var/lib/apt/extended_states"), "utf8").split("\n\n")) {
            const name = /^Package: (.*)$/m.exec(block)?.[1]?.trim();
            if (name && /^Auto-Installed: 1$/m.test(block)) auto.add(name);
        }
    } catch {}
    return auto;
}

/** Installed by the user in the old system: manual there, missing from the new image. */
export function packagesToInstall(oldRoot: string, newRoot: string): string[] {
    const before = installed(oldRoot);
    const after = installed(newRoot);
    const auto = automatic(oldRoot);
    return [...before.values()]
        .filter((p) => !after.has(p.name) && !auto.has(p.name) && (p.arch === "amd64" || p.arch === "all"))
        .map((p) => p.name)
        .sort();
}

/** Copy one regular file from the old root to the same place in the new one, keeping owner and mode. */
function carryFile(oldRoot: string, newRoot: string, path: string): boolean {
    if (!path.startsWith("/etc/") || path.split("/").includes("..")) return false;
    const src = join(oldRoot, path);
    const dest = join(newRoot, path);
    let st;
    try {
        st = lstatSync(src);
    } catch {
        return false;
    }
    if (!st.isFile()) return false;
    // Parents come from the new image, but a symlink must not lead out of it.
    mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
    const real = realpathSync(newRoot);
    if (realpathSync(dirname(dest)) !== real && !realpathSync(dirname(dest)).startsWith(real + "/")) return false;
    if (existsSync(dest) && !lstatSync(dest).isFile()) return false;
    copyFileSync(src, dest);
    chownSync(dest, st.uid, st.gid);
    chmodSync(dest, st.mode & 0o7777);
    return true;
}

/** Config files edited in the old system whose package is in the new one, and units only the old one has. */
export function carry(oldRoot: string, newRoot: string): string[] {
    const copied: string[] = [];
    const after = installed(newRoot);
    for (const p of installed(oldRoot).values()) {
        if (!after.has(p.name)) continue;
        for (const [path, md5] of p.conffiles) {
            const file = join(oldRoot, path);
            try {
                if (!lstatSync(file).isFile()) continue;
            } catch {
                continue; // deleted by the user: the new package's copy stays
            }
            if (new Bun.CryptoHasher("md5").update(readFileSync(file)).digest("hex") === md5) continue;
            if (carryFile(oldRoot, newRoot, path)) copied.push(path);
        }
    }
    const units = join(oldRoot, "etc/isol");
    for (const f of existsSync(units) ? readdirSync(units) : []) {
        if (!f.endsWith(".json") || existsSync(join(newRoot, "etc/isol", f))) continue;
        if (carryFile(oldRoot, newRoot, `/etc/isol/${f}`)) copied.push(`/etc/isol/${f}`);
    }
    return copied.sort();
}

if (import.meta.main) {
    const [cmd, oldRoot, newRoot] = process.argv.slice(2);
    if (!oldRoot || !newRoot) {
        console.error("usage: system-diff.ts packages|carry <old-root> <new-root>");
        process.exit(2);
    }
    const lines = cmd === "packages" ? packagesToInstall(oldRoot, newRoot) : cmd === "carry" ? carry(oldRoot, newRoot) : null;
    if (!lines) process.exit(2);
    if (lines.length) console.log(lines.join("\n"));
}
