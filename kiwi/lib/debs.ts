import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Ubuntu packages without apt: resolve dependencies against the system image's
// dpkg database (read-only), download the missing .debs over HTTPS, check them
// against the SHA-256 in the archive's Packages index and unpack their files
// into a private root on user.img. Maintainer scripts never run; callers
// generate whatever config those scripts would have made.
//
// Trust: Packages indexes come over HTTPS from the archive and every .deb is
// checked against them; the InRelease GPG signature is not verified.

export interface DebSource {
    url: string;
    /** {codename} is the system image's release, e.g. noble. */
    suites: string[];
    components: string[];
}

/** Package sources a software can use (by name); Ubuntu's archive is always included. */
export const SOURCES: Record<string, DebSource> = {
    ubuntu: {
        url: "https://archive.ubuntu.com/ubuntu",
        suites: ["{codename}", "{codename}-updates", "{codename}-security"],
        components: ["main", "universe"],
    },
    // Ondřej Surý's PHP builds: every PHP version side by side, with extensions.
    "ondrej-php": {
        url: "https://ppa.launchpadcontent.net/ondrej/php/ubuntu",
        suites: ["{codename}"],
        components: ["main"],
    },
};
/** Where downloaded Packages indexes are kept (on user.img). */
export const DEB_CACHE = "/www/softwares/.apt";
const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Never unpacked: init systems and packaging helpers only maintainer scripts
 * use. A dependency on one of these counts as satisfied.
 */
const EXCLUDE = new Set([
    "systemd", "systemd-dev", "systemd-sysv", "systemd-tmpfiles", "libsystemd-shared", "init-system-helpers",
    "ucf", "debconf", "dpkg", "install-info", "sensible-utils", "tzdata",
]);

export interface DebPackage {
    name: string;
    /** Base URL of the source it came from (Filename is relative to it). */
    base: string;
    version: string;
    depends: string;
    preDepends: string;
    provides: string[];
    filename: string;
    sha256: string;
    size: number;
    description: string;
    section: string;
}

interface Index {
    /** Newest version of each package across the suites. */
    packages: Map<string, DebPackage>;
    /** Virtual package -> real packages providing it. */
    providers: Map<string, string[]>;
}

// ---- dpkg version comparison ----------------------------------------------

function order(c: string): number {
    if (c === "~") return -1;
    if (/\d/.test(c)) return 0;
    if (!c) return 0;
    if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
    return c.charCodeAt(0) + 256;
}

function verrevcmp(a: string, b: string): number {
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
        let firstDiff = 0;
        while ((i < a.length && !/\d/.test(a[i])) || (j < b.length && !/\d/.test(b[j]))) {
            const ac = order(a[i] ?? ""), bc = order(b[j] ?? "");
            if (ac !== bc) return ac - bc;
            i++;
            j++;
        }
        while (a[i] === "0") i++;
        while (b[j] === "0") j++;
        while (/\d/.test(a[i] ?? "") && /\d/.test(b[j] ?? "")) {
            if (!firstDiff) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
            i++;
            j++;
        }
        if (/\d/.test(a[i] ?? "")) return 1;
        if (/\d/.test(b[j] ?? "")) return -1;
        if (firstDiff) return firstDiff;
    }
    return 0;
}

/** Debian version comparison (epoch:upstream-revision). */
export function compareVersions(a: string, b: string): number {
    const split = (v: string) => {
        const e = v.indexOf(":");
        const epoch = e >= 0 ? Number(v.slice(0, e)) : 0;
        const rest = e >= 0 ? v.slice(e + 1) : v;
        const r = rest.lastIndexOf("-");
        return { epoch, up: r >= 0 ? rest.slice(0, r) : rest, rev: r >= 0 ? rest.slice(r + 1) : "" };
    };
    const x = split(a), y = split(b);
    if (x.epoch !== y.epoch) return x.epoch - y.epoch;
    return verrevcmp(x.up, y.up) || verrevcmp(x.rev, y.rev);
}

function satisfies(version: string, op: string | undefined, want: string | undefined): boolean {
    if (!op || !want) return true;
    const c = compareVersions(version, want);
    switch (op) {
        case ">=": return c >= 0;
        case "<=": return c <= 0;
        case ">>": return c > 0;
        case "<<": return c < 0;
        case "=": return c === 0;
        default: return true;
    }
}

// ---- Indexes ----------------------------------------------------------------

function parseStanzas(text: string, each: (f: Record<string, string>) => void) {
    for (const block of text.split("\n\n")) {
        if (!block.trim()) continue;
        const f: Record<string, string> = {};
        let key = "";
        for (const line of block.split("\n")) {
            if (line.startsWith(" ") || line.startsWith("\t")) {
                if (key) f[key] += "\n" + line;
                continue;
            }
            const i = line.indexOf(":");
            if (i <= 0) continue;
            key = line.slice(0, i);
            f[key] = line.slice(i + 1).trim();
        }
        each(f);
    }
}

const names = (field: string | undefined) => (field ?? "").split(",").map((p) => p.trim().split(/[\s(]/)[0].split(":")[0]).filter(Boolean);

/** Installed packages in the system image (name -> version), virtual ones included. */
export function systemPackages(statusFile = "/var/lib/dpkg/status"): Map<string, string> {
    const installed = new Map<string, string>();
    parseStanzas(readFileSync(statusFile, "utf8"), (f) => {
        if (!/\binstall ok installed\b/.test(f.Status ?? "")) return;
        installed.set(f.Package, f.Version);
        for (const p of (f.Provides ?? "").split(",")) {
            const m = /^\s*([^\s(]+)(?:\s*\(\s*=\s*([^)\s]+)\s*\))?/.exec(p);
            if (m && !installed.has(m[1])) installed.set(m[1], m[2] ?? f.Version);
        }
    });
    return installed;
}

function codename(): string {
    try {
        return /^VERSION_CODENAME=(\S+)/m.exec(readFileSync("/etc/os-release", "utf8"))?.[1] ?? "noble";
    } catch {
        return "noble";
    }
}

async function download(url: string, dest: string) {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await Bun.write(dest, res);
}

const memo = ((globalThis as any).__kiwiDebIndexes ??= new Map<string, { at: number; index: Index }>()) as Map<string, { at: number; index: Index }>;
const sourceKey = (extra: string[]) => ["ubuntu", ...extra.filter((s) => s !== "ubuntu" && s in SOURCES)].join("+");

/** The index if it is already loaded (never blocks on the network). */
export function cachedIndex(sources: string[] = []): Index | null {
    const m = memo.get(sourceKey(sources));
    return m && Date.now() - m.at < INDEX_TTL_MS ? m.index : null;
}

/**
 * Packages index of Ubuntu's archive plus `sources` (see SOURCES), newest
 * version of each package across all of them. Cached on disk and in memory.
 */
export function loadIndex(cacheDir: string, sources: string[] = []): Promise<Index> {
    const key = sourceKey(sources);
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < INDEX_TTL_MS) return Promise.resolve(hit.index);
    // One download at a time per source set: a page warming the index and an
    // install starting must not unpack the same files over each other.
    let pending = inflight.get(key);
    if (!pending) {
        pending = buildIndex(cacheDir, key).finally(() => inflight.delete(key));
        inflight.set(key, pending);
    }
    return pending;
}

const inflight = ((globalThis as any).__kiwiDebInflight ??= new Map<string, Promise<Index>>()) as Map<string, Promise<Index>>;

async function buildIndex(cacheDir: string, key: string): Promise<Index> {
    mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
    const release = codename();
    const packages = new Map<string, DebPackage>();
    const providers = new Map<string, string[]>();
    for (const name of key.split("+")) {
        const src = SOURCES[name];
        for (const suite of src.suites.map((x) => x.replace("{codename}", release))) {
            for (const c of src.components) {
                const file = join(cacheDir, `${name}_${suite}_${c}_Packages`);
                const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < INDEX_TTL_MS;
                if (!fresh) {
                    const xz = `${file}.xz`;
                    await download(`${src.url}/dists/${suite}/${c}/binary-amd64/Packages.xz`, xz);
                    const p = Bun.spawnSync(["xz", "-d", "-f", xz], { stderr: "pipe" });
                    if (p.exitCode !== 0) throw new Error(`xz: ${p.stderr.toString()}`);
                }
                parseStanzas(readFileSync(file, "utf8"), (f) => {
                    if (!f.Package || !f.Filename || !f.SHA256) return;
                    const prev = packages.get(f.Package);
                    if (prev && compareVersions(prev.version, f.Version) >= 0) return;
                    packages.set(f.Package, {
                        name: f.Package,
                        base: src.url,
                        version: f.Version,
                        depends: f.Depends ?? "",
                        preDepends: f["Pre-Depends"] ?? "",
                        provides: names(f.Provides),
                        filename: f.Filename,
                        sha256: f.SHA256,
                        size: Number(f.Size) || 0,
                        description: (f.Description ?? "").split("\n")[0],
                        section: f.Section ?? "",
                    });
                });
            }
        }
    }
    for (const p of packages.values()) {
        for (const v of p.provides) providers.set(v, [...(providers.get(v) ?? []), p.name]);
    }
    const index = { packages, providers };
    memo.set(key, { at: Date.now(), index });
    return index;
}

/**
 * Packages to unpack so that `wanted` works on this system: the wanted ones
 * plus every dependency the system image doesn't satisfy (missing, or too
 * old), skipping anything already in `have`.
 */
export function resolve(
    index: Index, wanted: string[], installed: Map<string, string>, have: Set<string> = new Set(),
    /** More packages to treat as present, e.g. GL drivers a VNC desktop never loads. */
    exclude: string[] = [],
): DebPackage[] {
    const picked = new Map<string, DebPackage>();
    const queue = [...wanted];
    const skip = new Set([...EXCLUDE, ...exclude]);
    const ok = (name: string, op?: string, ver?: string) => {
        if (picked.has(name) || have.has(name) || skip.has(name)) return true;
        const v = installed.get(name);
        // A library the system image already has counts whatever its build: Ubuntu's updates
        // within a release keep library ABIs compatible, and re-bundling a newer build of
        // something like ICU or Perl's libraries costs tens of MB for nothing.
        return v !== undefined && (satisfies(v, op, ver) || name.startsWith("lib"));
    };
    while (queue.length) {
        const name = queue.shift()!;
        if (picked.has(name) || have.has(name)) continue;
        const pkg = index.packages.get(name);
        if (!pkg) throw new Error(`package ${name} is not in the archive`);
        picked.set(name, pkg);
        for (const group of `${pkg.preDepends},${pkg.depends}`.split(",").map((g) => g.trim()).filter(Boolean)) {
            type Alt = { name: string; op?: string; ver?: string };
            const alts = group.split("|").flatMap((a): Alt[] => {
                const m = /^([^\s(:]+)(?::\S+)?\s*(?:\(\s*([<>=]+)\s*([^)\s]+)\s*\))?/.exec(a.trim());
                return m ? [{ name: m[1], op: m[2], ver: m[3] }] : [];
            });
            if (alts.some((a) => ok(a.name, a.op, a.ver))) continue;
            // First alternative the archive can satisfy: a real package, else a provider.
            const real = alts.find((a) => index.packages.has(a.name) && satisfies(index.packages.get(a.name)!.version, a.op, a.ver));
            const provided = alts.map((a) => index.providers.get(a.name)?.[0]).find(Boolean);
            const choice = real?.name ?? provided;
            if (!choice) throw new Error(`${name} needs ${group}, which is not available`);
            queue.push(choice);
        }
    }
    return [...picked.values()];
}

// ---- Unpacking ----------------------------------------------------------------

/** Members of an ar archive (the .deb container). */
function arMembers(buf: Uint8Array): Map<string, Uint8Array> {
    const magic = new TextDecoder().decode(buf.subarray(0, 8));
    if (magic !== "!<arch>\n") throw new Error("not a .deb (bad ar header)");
    const out = new Map<string, Uint8Array>();
    let off = 8;
    const dec = new TextDecoder();
    while (off + 60 <= buf.length) {
        const header = dec.decode(buf.subarray(off, off + 60));
        const name = header.slice(0, 16).trim().replace(/\/$/, "");
        const size = parseInt(header.slice(48, 58).trim(), 10);
        off += 60;
        out.set(name, buf.subarray(off, off + size));
        off += size + (size % 2);
    }
    return out;
}

/** Never needed in an unpacked root (no man, no info, LANG=C.UTF-8): dropped to save space. */
const PRUNE = ["usr/share/doc", "usr/share/man", "usr/share/info", "usr/share/lintian", "usr/share/help", "usr/share/bug", "usr/share/doc-base", "usr/share/locale"];

/** Remove documentation and translations from an unpacked root. */
export function prune(root: string) {
    for (const p of PRUNE) rmSync(join(root, p), { recursive: true, force: true });
}

/** Download, verify and unpack `pkgs` into `root` (which gets usr/, etc/, ...). */
export async function unpack(pkgs: DebPackage[], root: string, workDir: string, progress?: (done: number, total: number, name: string) => void) {
    mkdirSync(root, { recursive: true, mode: 0o755 });
    mkdirSync(workDir, { recursive: true, mode: 0o755 });
    const total = pkgs.reduce((n, p) => n + p.size, 0);
    let done = 0;
    for (const p of pkgs) {
        progress?.(done, total, p.name);
        const res = await fetch(`${p.base}/${p.filename}`, { signal: AbortSignal.timeout(300_000) });
        if (!res.ok) throw new Error(`${p.name}: HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        const sum = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
        if (sum !== p.sha256) throw new Error(`${p.name}: checksum mismatch`);
        const members = arMembers(buf);
        const dataName = [...members.keys()].find((n) => n.startsWith("data.tar"));
        if (!dataName) throw new Error(`${p.name}: no data.tar in the package`);
        let data = members.get(dataName)!;
        const tar = join(workDir, `${p.name}.tar`);
        if (dataName.endsWith(".zst")) data = Bun.zstdDecompressSync(data);
        writeFileSync(tar, data);
        const flag = dataName.endsWith(".xz") ? "-xJf" : dataName.endsWith(".gz") ? "-xzf" : "-xf";
        const x = Bun.spawnSync(["tar", flag, tar, "-C", root, "--no-same-owner", "--keep-directory-symlink"], { stderr: "pipe" });
        rmSync(tar, { force: true });
        if (x.exitCode !== 0) throw new Error(`${p.name}: unpacking failed: ${x.stderr.toString().trim()}`);
        done += p.size;
    }
    prune(root);
    progress?.(total, total, "");
}

/** Packages recorded in a root by `recordPackages`. */
export function rootPackages(root: string): Record<string, string> {
    try {
        return JSON.parse(readFileSync(join(root, ".kiwi-packages.json"), "utf8"));
    } catch {
        return {};
    }
}

export function recordPackages(root: string, pkgs: DebPackage[]) {
    const all = { ...rootPackages(root), ...Object.fromEntries(pkgs.map((p) => [p.name, p.version])) };
    writeFileSync(join(root, ".kiwi-packages.json.tmp"), JSON.stringify(all, null, 2) + "\n");
    renameSync(join(root, ".kiwi-packages.json.tmp"), join(root, ".kiwi-packages.json"));
}
