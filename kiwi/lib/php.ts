import { createHash } from "node:crypto";
import { connect } from "node:net";
import { chmodSync, chownSync, copyFileSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agent } from "./host";
import { DEB_CACHE, loadIndex, recordPackages, resolve, rootPackages, systemPackages, unpack } from "./debs";

// PHP-FPM for kiwi, from two places:
//
//  - the system image (apt-get install php8.3-fpm on the host): units in
//    /etc/isol, config in /etc/php/<ver> (read-only here);
//  - the Software page (PHP packages unpacked onto user.img, versions side by side):
//      /www/softwares/php/<ver>/root     the packages' files
//      /www/softwares/php/<ver>/bin      php<ver>, php-fpm<ver> (php = the default version)
//      /www/php/<ver>/{fpm,cli}/php.ini  config, kept across upgrades
//      /www/php/<ver>/{fpm,cli}/conf.d   enabled modules (links to mods-available) + kiwi settings
//      /www/php/<ver>/mods-available     one .ini per extension
//      /www/php/<ver>/fpm/pool.d         FPM pools
//      /www/services/php<ver>-fpm.json   its isol unit
//
// Either way each version is the isol unit "php<ver>-fpm" listening on
// Ubuntu's default pool socket /run/php/php<ver>-fpm.sock.

const UNITS_DIR = process.env.KIWIN_UNITS_DIR ?? "/etc/isol";
const USER_UNITS_DIR = "/www/services";
const USER_PHP_DIR = "/www/softwares/php";
export const PHP_CONF = "/www/php";
/** Where the Software page's PHP builds come from, besides Ubuntu (see lib/debs.ts). */
const SOURCES = ["ondrej-php"];
const compareMinor = (a: string, b: string) => {
    const [x1, y1] = a.split(".").map(Number), [x2, y2] = b.split(".").map(Number);
    return x1 - x2 || y1 - y2;
};
export type Sapi = "fpm" | "cli";
export const SAPIS: Sapi[] = ["fpm", "cli"];

/** Settings kiwi manages in conf.d/99-kiwi.ini, applied to both SAPIs. */
export const SETTINGS = [
    { key: "memory_limit", label: "Memory limit", hint: "e.g. 256M" },
    { key: "upload_max_filesize", label: "Max upload size", hint: "e.g. 64M" },
    { key: "post_max_size", label: "Max POST size", hint: "at least the upload size" },
    { key: "max_execution_time", label: "Max execution time (s)", hint: "0 = unlimited" },
    { key: "max_input_vars", label: "Max input vars", hint: "default 1000" },
    { key: "date.timezone", label: "Time zone", hint: "e.g. Europe/Berlin" },
    { key: "display_errors", label: "Display errors", hint: "Off in production" },
] as const;
const SETTING_KEYS = new Set<string>(SETTINGS.map((s) => s.key));

export interface PhpModule {
    name: string;
    priority: number;
    fpm: boolean;
    cli: boolean;
}

export interface PhpExtensionPackage {
    name: string;
    module: string;
    description: string;
    version: string;
    installed: boolean;
}

const VERSION = /^\d+\.\d+$/;

/** What a website's pool needs to know about it (see KiwiNginx's Site). */
export interface PhpSite {
    domain: string;
    php?: string;
    enabled: boolean;
    type: string;
    /** Relaxations, both off unless the admin turned them on. */
    phpAllow?: { shell?: boolean; files?: boolean };
    /** More folders the site's code may use, besides its own. */
    phpPaths?: string[];
    /** The numeric user (and group) its pool runs as. */
    uid?: number;
}

/**
 * Not callable from a website unless its "shell commands" switch is on: what
 * a web shell uses to run programs (and putenv/dl/symlink, the usual ways
 * around such a list). The php command line is not affected.
 */
export const SHELL_FUNCTIONS = [
    "exec", "passthru", "shell_exec", "system", "proc_open", "popen", "expect_popen",
    "pcntl_exec", "pcntl_fork", "pcntl_signal", "pcntl_alarm",
    "putenv", "dl", "symlink", "link", "proc_nice",
    "posix_kill", "posix_mkfifo", "posix_setsid", "posix_setpgid", "posix_setuid", "posix_setgid", "posix_seteuid", "posix_setegid",
];

const WEB_DIR = "/www/sites";
/** Sites' PHP users start here, far from the system's accounts. They need no /etc/passwd entry. */
export const SITE_UID_MIN = 20000;
const PROBE = "kiwi-probe.php";
const PROBE_OK = "kiwi-probe-ok";

export function wwwDataUid(): number {
    const n = Number(run(["id", "-u", "www-data"]).out);
    return Number.isInteger(n) && n > 0 ? n : 33;
}

/** Run one script through a PHP-FPM socket and return its output (headers included). */
function fastcgi(socket: string, script: string, timeoutMs = 8000): Promise<string> {
    const record = (type: number, body: Uint8Array) => {
        const h = Buffer.alloc(8);
        h[0] = 1;
        h[1] = type;
        h.writeUInt16BE(1, 2);
        h.writeUInt16BE(body.length, 4);
        return Buffer.concat([h, body]);
    };
    const pair = (k: string, v: string) => {
        const len = (n: number) => {
            if (n < 128) return Buffer.from([n]);
            const b = Buffer.alloc(4);
            b.writeUInt32BE((n | 0x80000000) >>> 0, 0);
            return b;
        };
        return Buffer.concat([len(Buffer.byteLength(k)), len(Buffer.byteLength(v)), Buffer.from(k), Buffer.from(v)]);
    };
    const params = Buffer.concat(Object.entries({
        SCRIPT_FILENAME: script, SCRIPT_NAME: "/probe", REQUEST_URI: "/probe", REQUEST_METHOD: "GET", QUERY_STRING: "",
        SERVER_PROTOCOL: "HTTP/1.1", SERVER_NAME: "kiwi", REMOTE_ADDR: "127.0.0.1",
    }).map(([k, v]) => pair(k, v)));
    return new Promise((resolve, reject) => {
        const c = connect(socket);
        let out = Buffer.alloc(0);
        const timer = setTimeout(() => c.destroy(new Error("timed out")), timeoutMs);
        c.on("connect", () => c.write(Buffer.concat([record(1, Buffer.from([0, 1, 0, 0, 0, 0, 0, 0])), record(4, params), record(4, Buffer.alloc(0)), record(5, Buffer.alloc(0))])));
        c.on("data", (d: Buffer) => (out = Buffer.concat([out, d])));
        c.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        c.on("close", () => {
            clearTimeout(timer);
            let text = "";
            for (let o = 0; o + 8 <= out.length;) {
                const len = out.readUInt16BE(o + 4);
                if (out[o + 1] === 6 || out[o + 1] === 7) text += out.subarray(o + 8, o + 8 + len).toString();
                o += 8 + len + out[o + 6];
            }
            resolve(text);
        });
    });
}
const POOL_PREFIX = "site-";
/** A folder path safe to put in a pool file. */
const POOL_PATH = /^\/[A-Za-z0-9._\/-]{1,200}$/;
const MODULE = /^[a-z0-9_]+$/;

function run(cmd: string[]) {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function systemVersions(): string[] {
    try {
        return readdirSync("/usr/sbin").map((f) => f.match(/^php-fpm(\d+\.\d+)$/)?.[1]).filter((v): v is string => !!v);
    } catch {
        return [];
    }
}

export class KiwiPhp {
    /** Installed PHP-FPM versions, newest first, e.g. ["8.3", "8.1"]. */
    static versions(): string[] {
        const all = new Set([...systemVersions(), ...this.userInstalls().keys()]);
        return [...all].sort((a, b) => compareMinor(b, a));
    }

    /** PHP versions installed from Software: version -> its directory under /www/softwares/php. */
    static userInstalls(): Map<string, string> {
        const out = new Map<string, string>();
        let dirs: string[] = [];
        try {
            dirs = readdirSync(USER_PHP_DIR).filter((d) => d !== "bin" && d !== "current" && !d.startsWith("."));
        } catch {
            return out;
        }
        // A directory named after its version wins over an older layout's.
        for (const d of dirs.sort((a, b) => Number(VERSION.test(a)) - Number(VERSION.test(b)))) {
            try {
                for (const f of readdirSync(join(USER_PHP_DIR, d, "root/usr/sbin"))) {
                    const v = /^php-fpm(\d+\.\d+)$/.exec(f)?.[1];
                    if (v) out.set(v, join(USER_PHP_DIR, d));
                }
            } catch {}
        }
        return out;
    }

    /** The default user.img PHP (what `php` runs), else the newest one. */
    static userVersion(): string | null {
        const installs = this.userInstalls();
        try {
            const cur = realpathSync(join(USER_PHP_DIR, "current"));
            for (const [v, dir] of installs) if (dir === cur) return v;
        } catch {}
        return [...installs.keys()].sort((a, b) => compareMinor(b, a))[0] ?? null;
    }

    /** Managed on user.img (vs. the read-only system image). */
    static isUser(version: string): boolean {
        return this.userInstalls().has(version) && !systemVersions().includes(version);
    }

    /** Package root of a user.img version. */
    static root(version: string): string {
        const dir = this.userInstalls().get(version);
        if (!dir) throw new Error(`PHP ${version} is not installed from Software`);
        return join(dir, "root");
    }

    static socket(version: string): string {
        return `/run/php/php${version}-fpm.sock`;
    }

    // ---- One locked-down pool per website -----------------------------------
    //
    // Every PHP site gets its own FPM pool (<ver>/fpm/pool.d/site-<domain>.conf)
    // running as its own numeric user, instead of sharing "www" as www-data:
    //  - its code can't run shell commands and can't open files outside
    //    /www/sites/<domain> (php_admin_value: ini_set() and .user.ini can't undo it);
    //  - even code that gets around PHP's own limits is a user that can't enter
    //    other PHP sites' folders, connect to their FPM sockets (www-data only,
    //    for nginx) or use their cached scripts (opcache.validate_permission);
    //  - uploads and sessions stay in the site's folder.

    /** Only versions installed from Software have their config on user.img. */
    static hasSitePools(version: string | undefined): version is string {
        return !!version && VERSION.test(version) && this.isUser(version);
    }

    /** Socket of a site's pool (hashed: socket paths are limited to 107 bytes). */
    static siteSocket(version: string, domain: string): string {
        return `/run/php/php${version}-${createHash("sha256").update(domain).digest("hex").slice(0, 16)}.sock`;
    }

    static hasPool(version: string, domain: string): boolean {
        return existsSync(this.poolFile(version, domain));
    }

    private static poolFile(version: string, domain: string) {
        return this.conf(version, "fpm", "pool.d", `${POOL_PREFIX}${domain}.conf`);
    }

    static sitePool(site: PhpSite): string {
        if (!Number.isInteger(site.uid) || site.uid! < SITE_UID_MIN) throw new Error(`${site.domain} has no PHP user`);
        const dir = join(WEB_DIR, site.domain);
        const open = [dir, ...(site.phpPaths ?? []).filter((p) => POOL_PATH.test(p) && !p.split("/").includes(".."))].map((p) => p.replace(/\/+$/, "") + "/");
        return [
            `; Written by kiwi for ${site.domain}. Don't edit: it is rewritten. Change it in Websites > ${site.domain} > PHP security.`,
            `[${site.domain}]`,
            `user = ${site.uid}`,
            `group = ${site.uid}`,
            `listen = ${this.siteSocket(site.php!, site.domain)}`,
            // nginx only: other sites' PHP users must not reach this pool.
            "listen.owner = www-data",
            "listen.group = www-data",
            "listen.mode = 0660",
            "pm = ondemand",
            "pm.max_children = 10",
            "pm.process_idle_timeout = 30s",
            "pm.max_requests = 500",
            `php_admin_value[upload_tmp_dir] = ${dir}/.php/tmp`,
            `php_admin_value[sys_temp_dir] = ${dir}/.php/tmp`,
            `php_admin_value[session.save_path] = ${dir}/.php/sessions`,
            "php_value[session.gc_probability] = 1",
            "php_admin_flag[allow_url_include] = off",
            "php_admin_flag[opcache.validate_permission] = on",
            ...(site.phpAllow?.files ? [] : [`php_admin_value[open_basedir] = ${open.join(":")}`]),
            ...(site.phpAllow?.shell ? [] : [`php_admin_value[disable_functions] = ${SHELL_FUNCTIONS.join(",")}`]),
            "",
        ].join("\n");
    }

    /**
     * Make the pool files match `sites` and check each changed version with
     * php-fpm --test. Nothing is reloaded yet: the caller commits once nginx
     * accepted its side, or reverts. commit() reloads PHP-FPM and asks each
     * changed pool to run a probe script; if one can't, everything goes back.
     */
    static preparePools(sites: PhpSite[]): { commit: () => Promise<void>; revert: () => void } {
        const before = new Map<string, string | null>();
        const changed = new Set<string>();
        const probe: PhpSite[] = [];
        const put = (file: string, content: string | null, version: string) => {
            const old = existsSync(file) ? readFileSync(file, "utf8") : null;
            if (old === content) return false;
            if (!before.has(file)) before.set(file, old);
            if (content === null) rmSync(file, { force: true });
            else writeFileSync(file, content, { mode: 0o644 });
            changed.add(version);
            return true;
        };
        const revert = () => {
            for (const [file, old] of before) {
                if (old === null) rmSync(file, { force: true });
                else writeFileSync(file, old, { mode: 0o644 });
            }
        };
        const www = wwwDataUid();
        for (const version of this.userInstalls().keys()) {
            if (!this.isUser(version) || !existsSync(this.conf(version, "fpm", "pool.d"))) continue;
            const mine = sites.filter((s) => s.type === "php" && s.enabled && s.php === version);
            const wanted = new Set(mine.map((s) => `${POOL_PREFIX}${s.domain}.conf`));
            for (const f of readdirSync(this.conf(version, "fpm", "pool.d"))) {
                if (f.startsWith(POOL_PREFIX) && f.endsWith(".conf") && !wanted.has(f)) put(this.conf(version, "fpm", "pool.d", f), null, version);
            }
            for (const s of mine) {
                const content = this.sitePool(s);
                const dir = join(WEB_DIR, s.domain);
                // The site's folder: its PHP user and nginx (group www-data) get in, other sites' users don't.
                mkdirSync(dir, { recursive: true, mode: 0o750 });
                chownSync(dir, s.uid!, www);
                chmodSync(dir, 0o750);
                // Uploads, sessions and the probe: in the site's folder, outside its web root.
                mkdirSync(join(dir, ".php"), { recursive: true, mode: 0o711 });
                chownSync(join(dir, ".php"), 0, 0);
                chmodSync(join(dir, ".php"), 0o711);
                for (const d of ["tmp", "sessions"]) {
                    mkdirSync(join(dir, ".php", d), { recursive: true, mode: 0o700 });
                    chownSync(join(dir, ".php", d), s.uid!, s.uid!);
                    chmodSync(join(dir, ".php", d), 0o700);
                }
                writeFileSync(join(dir, ".php", PROBE), `<?php echo "${PROBE_OK}";\n`, { mode: 0o644 });
                if (put(this.poolFile(version, s.domain), content, version)) probe.push(s);
            }
        }
        for (const version of changed) {
            const test = run([...this.fpmCommand(version), "--test"]);
            if (test.code !== 0) {
                revert();
                throw new Error(`PHP ${version} rejected the site's pool: ${(test.err || test.out).split("\n").slice(-3).join(" ")}`);
            }
        }
        return {
            revert,
            commit: async () => {
                try {
                    for (const version of changed) await this.reload(version);
                    for (const s of probe) {
                        const out = await fastcgi(this.siteSocket(s.php!, s.domain), join(WEB_DIR, s.domain, ".php", PROBE)).catch((e) => `no answer (${(e as Error).message})`);
                        if (!out.includes(PROBE_OK)) throw new Error(`PHP ${s.php} could not run ${s.domain} in its own pool: ${out.trim().slice(0, 200) || "empty answer"}`);
                    }
                } catch (e) {
                    revert();
                    for (const version of changed) await this.reload(version).catch(() => {});
                    throw e;
                }
            },
        };
    }

    /**
     * Give everything under `dir` to a site's PHP user (not following links).
     * With `from`, only what that user owned: what PHP could write before
     * the site had its own user (www-data) stays writable.
     */
    static chownTree(dir: string, uid: number, from?: number): number {
        let n = 0;
        const walk = (p: string) => {
            let st;
            try {
                st = lstatSync(p);
            } catch {
                return;
            }
            if (from === undefined || st.uid === from) {
                try {
                    lchownSync(p, uid, from === undefined || st.gid === from ? uid : st.gid);
                    n++;
                } catch {}
            }
            if (!st.isDirectory()) return;
            let names: string[] = [];
            try {
                names = readdirSync(p);
            } catch {}
            for (const name of names) walk(join(p, name));
        };
        for (const name of existsSync(dir) ? readdirSync(dir) : []) if (name !== ".php") walk(join(dir, name));
        return n;
    }

    static unitName(version: string): string {
        return `php${version}-fpm`;
    }

    static fpmCommand(version: string): string[] {
        return this.isUser(version) ? [this.wrapper(version, `php-fpm${version}`)] : [`/usr/sbin/php-fpm${version}`];
    }

    /** A version's own wrapper (bin/php8.4): bundled libraries, its php.ini and conf.d. */
    private static wrapper(version: string, cmd: string): string {
        const dir = this.userInstalls().get(version)!;
        const own = join(dir, "bin", cmd);
        // Installs from before versions were side by side only have "php" and "php-fpmX.Y".
        return existsSync(own) ? own : join(dir, "bin", cmd === `php${version}` ? "php" : cmd);
    }

    static conf(version: string, ...parts: string[]) {
        if (!VERSION.test(version)) throw new Error("invalid PHP version");
        return join(PHP_CONF, version, ...parts);
    }

    /** Make sure the isol unit for `version` exists and is running. */
    static async ensure(version: string): Promise<void> {
        if (!this.versions().includes(version)) throw new Error(`PHP ${version} is not installed`);
        const name = this.unitName(version);
        const user = this.isUser(version);
        const file = join(user ? USER_UNITS_DIR : UNITS_DIR, `${name}.json`);
        if (!existsSync(file)) {
            const fpm = this.fpmCommand(version);
            const config = user ? [] : ["--fpm-config", `/etc/php/${version}/fpm/php-fpm.conf`];
            mkdirSync(user ? USER_UNITS_DIR : UNITS_DIR, { recursive: true, mode: 0o755 });
            writeFileSync(file, JSON.stringify({
                description: `PHP ${version} FastCGI process manager${user ? " (installed from Software)" : ""}`,
                exec: [...fpm, "--nodaemonize", ...config],
                pre: [["/bin/mkdir", "-p", "/run/php"], [...fpm, "--test", ...config]],
                reloadSignal: "SIGUSR2",
                enabled: true,
                restart: "always",
                restartSec: 2,
                stopSignal: "SIGQUIT",
                stopTimeout: 15,
            }, null, 2) + "\n", { mode: 0o644 });
            // daemon-reload starts newly added, enabled units.
            await agent("/daemon-reload", {});
        } else {
            await agent(`/units/${name}/start`, {});
        }
    }

    static async status(version: string) {
        return agent<{ state: string; pid: number | null; error: string | null }>(`/units/${this.unitName(version)}`).catch(() => null);
    }

    /** Check the config, then reload (or start) PHP-FPM. */
    static async reload(version: string): Promise<void> {
        const test = run([...this.fpmCommand(version), "--test"]);
        if (test.code !== 0) throw new Error(`PHP-FPM config test failed: ${(test.err || test.out).split("\n").slice(-3).join(" ")}`);
        const st = await this.status(version);
        await agent(`/units/${this.unitName(version)}/${st?.state === "running" ? "reload" : "start"}`, {});
    }

    /** `php -v` first line. */
    static version(version: string): string | null {
        const cmd = this.isUser(version) ? [this.wrapper(version, `php${version}`), "-v"] : [`/usr/bin/php${version}`, "-v"];
        const r = run(cmd);
        return r.code === 0 ? r.out.split("\n")[0] : null;
    }

    // ---- user.img PHP: config, modules, settings --------------------------

    /** Before a Software version directory is deleted: stop and drop its PHP-FPM unit (its /www/php config stays). */
    static async removeDir(dir: string): Promise<void> {
        for (const [v, d] of this.userInstalls()) {
            if (d !== join(USER_PHP_DIR, dir)) continue;
            await agent(`/units/${this.unitName(v)}/stop`, {}).catch(() => {});
            rmSync(join(USER_UNITS_DIR, `${this.unitName(v)}.json`), { force: true });
            await agent("/daemon-reload", {}).catch(() => {});
        }
    }

    /** provision() for the version in a Software version directory ("8.4", or an older layout's name). */
    static async provisionDir(dir: string): Promise<void> {
        for (const [v, d] of this.userInstalls()) if (d === join(USER_PHP_DIR, dir)) return this.provision(v);
        throw new Error(`no PHP found in ${join(USER_PHP_DIR, dir)}`);
    }

    /**
     * Create (or complete) /www/php/<ver> for a PHP installed from Software and
     * start its FPM unit. Safe to run again: never overwrites the user's files;
     * extensions seen for the first time are enabled, like Debian does.
     */
    static async provision(v: string): Promise<void> {
        const USER_PHP = this.root(v);
        const api = readdirSync(join(USER_PHP, "usr/lib/php")).find((d) => /^\d{8}$/.test(d));
        if (!api) throw new Error("PHP extension directory not found");
        mkdirSync(this.conf(v, "mods-available"), { recursive: true, mode: 0o755 });
        for (const sapi of SAPIS) {
            mkdirSync(this.conf(v, sapi, "conf.d"), { recursive: true, mode: 0o755 });
            const base = join(USER_PHP, "usr/lib/php", v, "php.ini-production");
            const iniSrc = sapi === "cli" && existsSync(`${base}.cli`) ? `${base}.cli` : base;
            if (!existsSync(this.conf(v, sapi, "php.ini")) && existsSync(iniSrc)) copyFileSync(iniSrc, this.conf(v, sapi, "php.ini"));
            // Paths into the packages go through "current", so a version switch needs no edits.
            writeFileSync(this.conf(v, sapi, "conf.d", "00-kiwi-paths.ini"),
                `; Written by kiwi, do not edit: where the Software page put PHP's extensions.\nextension_dir = "${join(USER_PHP, "usr/lib/php", api)}"\n`);
        }

        // Extensions: Debian ships each module's ini as usr/share/php…/<group>/<mod>.ini and
        // its maintainer scripts copy it to mods-available. Do the same; enable modules never seen before.
        const known = new Set<string>(this.readJson(this.conf(v, ".known-modules.json"), []));
        for (const [f, src] of this.moduleSources(USER_PHP)) {
            const mod = f.replace(/\.ini$/, "");
            const dest = this.conf(v, "mods-available", f);
            if (!existsSync(dest)) copyFileSync(src, dest);
            if (!known.has(mod)) {
                for (const sapi of SAPIS) this.linkModule(v, mod, sapi, true);
                known.add(mod);
            }
        }
        writeFileSync(this.conf(v, ".known-modules.json"), JSON.stringify([...known].sort()) + "\n");

        // FPM: global config and the default pool, like Ubuntu's.
        mkdirSync(this.conf(v, "fpm", "pool.d"), { recursive: true, mode: 0o755 });
        if (!existsSync(this.conf(v, "fpm", "php-fpm.conf"))) {
            writeFileSync(this.conf(v, "fpm", "php-fpm.conf"), [
                "; PHP-FPM, installed from kiwi's Software page.",
                "[global]",
                `pid = /run/php/php${v}-fpm.pid`,
                `error_log = /var/log/php${v}-fpm.log`,
                `include = ${this.conf(v, "fpm", "pool.d")}/*.conf`,
                "",
            ].join("\n"));
        }
        if (!existsSync(this.conf(v, "fpm", "pool.d", "www.conf"))) {
            writeFileSync(this.conf(v, "fpm", "pool.d", "www.conf"), [
                "[www]",
                "user = www-data",
                "group = www-data",
                `listen = ${this.socket(v)}`,
                "listen.owner = www-data",
                "listen.group = www-data",
                "pm = dynamic",
                "pm.max_children = 10",
                "pm.start_servers = 2",
                "pm.min_spare_servers = 1",
                "pm.max_spare_servers = 3",
                "",
            ].join("\n"));
        }
        await this.ensure(v);
        await this.reload(v).catch(() => {});
    }

    /** "<mod>.ini" -> its file in the packages: usr/share/php…/<group>/<mod>.ini with an extension= line. */
    private static moduleSources(root: string): Map<string, string> {
        const out = new Map<string, string>();
        const share = join(root, "usr/share");
        for (const pkg of existsSync(share) ? readdirSync(share).filter((d) => d.startsWith("php")) : []) {
            let groups: string[] = [];
            try {
                groups = readdirSync(join(share, pkg));
            } catch {
                continue;
            }
            for (const g of groups) {
                let files: string[] = [];
                try {
                    files = readdirSync(join(share, pkg, g));
                } catch {
                    continue;
                }
                for (const f of files) {
                    if (!f.endsWith(".ini") || !MODULE.test(f.slice(0, -4))) continue;
                    const file = join(share, pkg, g, f);
                    try {
                        if (/^\s*(zend_)?extension\s*=/m.test(readFileSync(file, "utf8"))) out.set(f, file);
                    } catch {}
                }
            }
        }
        return out;
    }

    private static readJson<T>(file: string, fallback: T): T {
        try {
            return JSON.parse(readFileSync(file, "utf8"));
        } catch {
            return fallback;
        }
    }

    private static modulePriority(version: string, mod: string): number {
        try {
            return Number(/^;\s*priority\s*=\s*(\d+)/m.exec(readFileSync(this.conf(version, "mods-available", `${mod}.ini`), "utf8"))?.[1] ?? 20);
        } catch {
            return 20;
        }
    }

    private static enabledLink(version: string, mod: string, sapi: Sapi): string | null {
        const dir = this.conf(version, sapi, "conf.d");
        if (!existsSync(dir)) return null;
        const f = readdirSync(dir).find((n) => n.replace(/^\d+-/, "") === `${mod}.ini`);
        return f ? join(dir, f) : null;
    }

    private static linkModule(version: string, mod: string, sapi: Sapi, on: boolean) {
        const current = this.enabledLink(version, mod, sapi);
        if (!on) {
            if (current && lstatSync(current).isSymbolicLink()) rmSync(current);
            return;
        }
        if (current) return;
        const prio = String(this.modulePriority(version, mod)).padStart(2, "0");
        symlinkSync(join("..", "..", "mods-available", `${mod}.ini`), this.conf(version, sapi, "conf.d", `${prio}-${mod}.ini`));
    }

    static modules(version: string): PhpModule[] {
        const dir = this.conf(version, "mods-available");
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
            .filter((f) => f.endsWith(".ini") && MODULE.test(f.slice(0, -4)))
            .map((f) => {
                const name = f.slice(0, -4);
                return { name, priority: this.modulePriority(version, name), fpm: !!this.enabledLink(version, name, "fpm"), cli: !!this.enabledLink(version, name, "cli") };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    static async setModule(version: string, mod: string, sapi: Sapi, on: boolean): Promise<void> {
        if (!this.isUser(version)) throw new Error(`PHP ${version} is managed in the system image`);
        if (!MODULE.test(mod) || !existsSync(this.conf(version, "mods-available", `${mod}.ini`))) throw new Error(`unknown module ${mod}`);
        this.linkModule(version, mod, sapi, on);
        if (sapi === "fpm") await this.reload(version);
    }

    /** Values from conf.d/99-kiwi.ini (fpm; cli gets the same file). */
    static settings(version: string): Record<string, string> {
        const out: Record<string, string> = {};
        try {
            for (const line of readFileSync(this.conf(version, "fpm", "conf.d", "99-kiwi.ini"), "utf8").split("\n")) {
                const m = /^\s*([\w.]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
                if (m && SETTING_KEYS.has(m[1])) out[m[1]] = m[2];
            }
        } catch {}
        return out;
    }

    /** Effective value of a setting (php -r ini_get) for display next to the form. */
    static effective(version: string, keys: string[]): Record<string, string> {
        if (!this.isUser(version)) return {};
        const code = `foreach (${JSON.stringify(keys).replace(/"/g, "'")} as $k) echo $k, "=", ini_get($k), "\\n";`;
        const r = run([this.wrapper(version, `php${version}`), "-r", code]);
        const out: Record<string, string> = {};
        for (const line of r.out.split("\n")) {
            const i = line.indexOf("=");
            if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
        }
        return out;
    }

    static async saveSettings(version: string, values: Record<string, string>): Promise<void> {
        if (!this.isUser(version)) throw new Error(`PHP ${version} is managed in the system image`);
        const lines = ["; Written by kiwi's PHP page. Edit php.ini for anything else."];
        for (const [k, v] of Object.entries(values)) {
            if (!SETTING_KEYS.has(k) || v === "") continue;
            if (!/^[\w./:+-]{1,64}$/.test(v)) throw new Error(`${k}: invalid value`);
            lines.push(`${k} = "${v}"`);
        }
        for (const sapi of SAPIS) {
            const file = this.conf(version, sapi, "conf.d", "99-kiwi.ini");
            writeFileSync(`${file}.tmp`, lines.join("\n") + "\n");
            renameSync(`${file}.tmp`, file);
        }
        await this.reload(version);
    }

    // ---- Extension packages (php<ver>-*) -----------------------------------

    /** Extension packages for the user.img PHP from Ubuntu's archive, with what's installed. */
    static async extensionPackages(v: string): Promise<PhpExtensionPackage[]> {
        if (!this.isUser(v)) return [];
        const index = await loadIndex(DEB_CACHE, SOURCES);
        const have = rootPackages(this.root(v));
        const skip = new Set(["cli", "fpm", "cgi", "dev", "phpdbg", "common", "readline", "opcache"].map((x) => `php${v}-${x}`));
        return [...index.packages.values()]
            .filter((p) => p.name.startsWith(`php${v}-`) && !skip.has(p.name))
            .map((p) => ({
                name: p.name,
                module: p.name.slice(`php${v}-`.length),
                description: p.description.replace(/ module for PHP$/i, "").replace(/^PHP /, ""),
                version: p.version,
                installed: p.name in have,
            }))
            .sort((a, b) => Number(b.installed) - Number(a.installed) || a.module.localeCompare(b.module));
    }

    /** Unpack an extension package (and the libraries it needs) into the PHP root, then enable it. */
    static async installExtension(v: string, pkg: string): Promise<string[]> {
        if (!this.isUser(v)) throw new Error(`PHP ${v} is not installed from Software`);
        if (!pkg.startsWith(`php${v}-`) || !/^php[\d.]+-[a-z0-9-]+$/.test(pkg)) throw new Error(`${pkg} is not a PHP ${v} extension`);
        const root = this.root(v);
        const index = await loadIndex(DEB_CACHE, SOURCES);
        const pkgs = resolve(index, [pkg], systemPackages(), new Set(Object.keys(rootPackages(root))));
        if (pkgs.length === 0) return [];
        await unpack(pkgs, root, join(root, "..", ".work"));
        rmSync(join(root, "..", ".work"), { recursive: true, force: true });
        recordPackages(root, pkgs);
        await this.provision(v); // copies the new mods-available ini and enables it
        return pkgs.map((p) => p.name);
    }
}
