import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agent } from "./host";
import { KiwiPhp, SITE_UID_MIN, wwwDataUid } from "./php";

// NGINX connector: websites managed from the kiwi panel.
//
// Everything that belongs to the user lives on user.img (/www):
//   /www/nginx/sites.json              site definitions (source of truth)
//   /www/nginx/protect.json            attack prevention settings shared by all sites
//   /www/nginx/sites/<domain>.conf     generated server blocks (root-only dir)
//   /www/nginx/certs/<domain>/         Let's Encrypt certificate + key
//   /www/nginx/logs/                   per-site access/error logs
//   /www/sites/<domain>/public_html/   web root of static and PHP sites
//   /www/sites/_acme/                  ACME HTTP-01 challenge files
// The system image only gets /etc/nginx/conf.d/kiwin-sites.conf, which
// includes the generated files. Every change is checked with `nginx -t` and
// rolled back if it fails, then nginx is reloaded through the isol agent.

const NGINX_DIR = "/www/nginx";
const SITES_CONF_DIR = join(NGINX_DIR, "sites");
/** Hand-edited configs (Websites > site > nginx configuration); used instead of the generated one. */
const CUSTOM_DIR = join(NGINX_DIR, "custom");
const customFile = (domain: string) => join(CUSTOM_DIR, `${domain}.conf`);
const MAX_CONFIG = 256 * 1024;
const LOG_DIR = join(NGINX_DIR, "logs");
export const CERT_DIR = join(NGINX_DIR, "certs");
const META = join(NGINX_DIR, "sites.json");
/** Attack prevention settings shared by every site (addresses that are never limited). */
const PROTECT_META = join(NGINX_DIR, "protect.json");
export const WEB_DIR = "/www/sites";
export const ACME_WEBROOT = join(WEB_DIR, "_acme");
/** Name of a site's web root folder (as on cPanel-style hosts). Sites before it used "public". */
export const WEB_ROOT = "public_html";
export const siteRoot = (domain: string) => join(WEB_DIR, domain, WEB_ROOT);
const INCLUDE_FILE = "/etc/nginx/conf.d/kiwin-sites.conf";
const NGINX = "/usr/sbin/nginx";
const UNIT = "nginx";

export const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
// Proxy targets go into the config verbatim, so no whitespace, quotes, ; { } $.
const PROXY = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~\/-]*)?$|^https?:\/\/\[[0-9a-f:]+\](?::\d{1,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/i;

/** Sites' PHP users stay below the ids systems give special meaning (nobody, 65534). */
const SITE_UID_MAX = 60000;

export type SiteType = "static" | "proxy" | "php";

export interface Site {
    domain: string;
    aliases: string[];
    type: SiteType;
    /** proxy: upstream URL */
    proxy?: string;
    /** php: PHP-FPM version, e.g. "8.3" */
    php?: string;
    enabled: boolean;
    createdAt: string;
    /** Let's Encrypt certificate, once issued. */
    ssl?: { issuedAt: string; expiresAt: string; staging?: boolean };
    /** Redirect HTTP to HTTPS (and send HSTS) when a certificate exists. */
    forceHttps?: boolean;
    /**
     * php: what the site's code may do beyond the default. By default it can't
     * run shell commands (shell) or open files outside its folder (files).
     */
    phpAllow?: { shell?: boolean; files?: boolean };
    /** php: more folders its code may use (an app's data folder outside the site). */
    phpPaths?: string[];
    /** php: the numeric user its own pool runs as (kept if the site stops being a PHP site). */
    uid?: number;
    /** Limits on spam traffic and attack tools; absent means the site is served unprotected. */
    protect?: Protection;
}

/** An address or range that is never rate limited (your office, a monitoring service). */
const TRUSTED = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9a-fA-F:]{2,45}(?:\/\d{1,3})?)$/;

export type ProtectLevel = "lenient" | "standard" | "strict";

/**
 * How hard each level leans on one visitor. The rate is what a single address
 * may keep up indefinitely; the burst is how much of a head start it gets, so
 * a page pulling dozens of images and scripts at once is never touched.
 */
const LEVELS: Record<ProtectLevel, { rate: string; burst: number; conn: number; label: string }> = {
    lenient: { rate: "40r/s", burst: 120, conn: 60, label: "40 requests a second per visitor" },
    standard: { rate: "15r/s", burst: 45, conn: 30, label: "15 requests a second per visitor" },
    strict: { rate: "5r/s", burst: 15, conn: 10, label: "5 requests a second per visitor" },
};

/** Per-site attack prevention. Absent means the site is served without any of it. */
export interface Protection {
    level: ProtectLevel;
    /** Refuse requests from known scanners and attack tools (by User-Agent). */
    blockTools?: boolean;
    /** Refuse requests for files attackers probe for (.env, .git, database dumps). */
    blockProbes?: boolean;
    /** php: a much harder limit on login and XML-RPC endpoints. */
    protectLogin?: boolean;
}

export const PROTECT_LEVELS = LEVELS;
/** What a new website gets. */
export const DEFAULT_PROTECTION: Protection = { level: "standard", blockTools: true, blockProbes: true, protectLogin: true };

interface ProtectMeta {
    /** Addresses and ranges exempt from every limit below. */
    trusted: string[];
}

// Tools that exist to break into or map out a site. Browsers, feed readers,
// search engine crawlers and ordinary API clients (curl, python-requests) are
// deliberately not in here: this must not cost the site real traffic.
const ATTACK_TOOLS = [
    "sqlmap", "nikto", "nmap", "masscan", "zgrab", "nuclei", "dirbuster", "gobuster", "feroxbuster",
    "wfuzz", "ffuf", "wpscan", "joomscan", "droopescan", "acunetix", "netsparker", "arachni", "nessus",
    "openvas", "metasploit", "havij", "jorgee", "zmeu", "morfeus", "cgichk", "whatweb", "xmlrpc brute",
    "libwww-perl", "netcrawler", "mj12bot",
].join("|");

/** Files and folders that only an attacker asks for; never part of a working site. */
const PROBE_PATHS = "(?:^|/)\\.(?:env|git|svn|hg|aws|ssh|htpasswd)(?:/|$)|^/vendor/(?:phpunit|composer)/|^/(?:wp-config|configuration|settings)\\.php[.~]|\\.(?:sql|sqlite|dump|bak|old|orig|save|swp|rdb|pem|key)$";

/** Endpoints attackers hammer with password guesses. */
const LOGIN_PATHS = "^/(?:wp-login\\.php|xmlrpc\\.php|wp-json/wp/v2/users|administrator/index\\.php|user/login|admin/login(?:\\.php)?)$";

function readProtectMeta(): ProtectMeta {
    try {
        const m = JSON.parse(readFileSync(PROTECT_META, "utf8")) as ProtectMeta;
        return { trusted: Array.isArray(m.trusted) ? m.trusted.filter((t) => TRUSTED.test(t)) : [] };
    } catch {
        return { trusted: [] };
    }
}

/**
 * The http-level part of attack prevention: the counters sites share and the
 * tests a request is measured against. Everything is keyed per site and per
 * address, so one site being attacked never costs another site its visitors,
 * and a trusted address gets an empty key, which nginx does not count at all.
 */
function includeText(): string {
    const trusted = readProtectMeta().trusted;
    const zones = (Object.keys(LEVELS) as ProtectLevel[])
        .map((l) => `limit_req_zone $kiwin_limit_key zone=kiwin_${l}:10m rate=${LEVELS[l].rate};`)
        .join("\n");
    return `# Managed by kiwi: websites from user storage (/www/nginx/sites).
map $http_upgrade $kiwin_connection_upgrade {
    default upgrade;
    ''      close;
}

# ---- Attack prevention (Websites > website > Attack prevention) ----
# Addresses that are never limited: this server itself, plus whatever was added
# in the panel. Their limit key is empty below, which nginx leaves uncounted.
geo $kiwin_trusted {
    default 0;
    127.0.0.0/8 1;
    ::1 1;
${trusted.map((t) => `    ${t} 1;\n`).join("")}}
map $kiwin_trusted $kiwin_limit_key {
    0 "$server_name$binary_remote_addr";
    1 "";
}
map $http_user_agent $kiwin_attack_tool {
    default 0;
    "~*(?:${ATTACK_TOOLS})" 1;
}
${zones}
# Password guessing is slow traffic, so it gets its own, much tighter counter.
limit_req_zone $kiwin_limit_key zone=kiwin_login:10m rate=20r/m;
limit_conn_zone $kiwin_limit_key zone=kiwin_conn:10m;
# 429 tells well-behaved clients (and search engines) to come back later.
limit_req_status 429;
limit_conn_status 429;
# At error level the refusals land in the site's own error log, which the panel shows.
limit_req_log_level error;

include ${SITES_CONF_DIR}/*.conf;
`;
}

export const certPaths = (domain: string) => ({
    dir: join(CERT_DIR, domain),
    fullchain: join(CERT_DIR, domain, "fullchain.pem"),
    key: join(CERT_DIR, domain, "privkey.pem"),
});

const hasCert = (site: Site) => !!site.ssl && existsSync(certPaths(site.domain).fullchain) && existsSync(certPaths(site.domain).key);

/** The site's own locked-down pool; the shared one only for PHP from the system image. */
const phpSocket = (site: Site) => (KiwiPhp.hasSitePools(site.php) ? KiwiPhp.siteSocket(site.php, site.domain) : KiwiPhp.socket(site.php!));

/**
 * Server-level attack prevention. The limits count one address at a time, so a
 * flood from a single source runs into them long before a visitor browsing the
 * site does; the timeouts drop connections that are opened only to be held
 * open (slowloris), which costs normal clients nothing.
 */
function protectServer(site: Site): string {
    const p = site.protect;
    if (!p) return "";
    const l = LEVELS[p.level] ?? LEVELS.standard;
    const tools = p.blockTools
        ? `\n    # Known scanners and attack tools, by User-Agent.\n    if ($kiwin_attack_tool) {\n        return 403;\n    }\n`
        : "";
    return `    # Attack prevention: ${l.label}, ${l.conn} connections at a time.
    limit_req zone=kiwin_${p.level} burst=${l.burst} nodelay;
    limit_conn kiwin_conn ${l.conn};
    client_header_timeout 20s;
    client_body_timeout 20s;
    send_timeout 30s;
${tools}
`;
}

/** Location blocks that must come before the site's own: probes and login endpoints. */
function protectLocations(site: Site): string {
    const p = site.protect;
    if (!p) return "";
    let out = "";
    if (p.blockProbes) {
        out += `    # Files only an attacker asks for; answered without touching the site.
    location ~* "${PROBE_PATHS}" {
        access_log off;
        deny all;
    }

`;
    }
    if (p.protectLogin && site.type === "php") {
        out += `    # Password guessing: a few tries a minute, then 429.
    location ~* "${LOGIN_PATHS}" {
        limit_req zone=kiwin_login burst=5 nodelay;
        limit_conn kiwin_conn ${(LEVELS[p.level] ?? LEVELS.standard).conn};
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${phpSocket(site)};
    }

`;
    }
    return out;
}

function siteBody(site: Site): string {
    const root = `    root ${siteRoot(site.domain)};`;
    const dotfiles = `    location ~ /\\.(?!well-known) {\n        deny all;\n    }`;
    switch (site.type) {
        case "proxy":
            return `${protectLocations(site)}    location / {
        proxy_pass ${site.proxy};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $kiwin_connection_upgrade;
    }`;
        case "php":
            return `${root}
    index index.php index.html index.htm;

${protectLocations(site)}    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${phpSocket(site)};
    }

${dotfiles}`;
        default:
            return `${root}
    index index.html index.htm;

${protectLocations(site)}    location / {
        try_files $uri $uri/ =404;
    }

${dotfiles}`;
    }
}

function serverBlocks(site: Site): string {
    const names = [site.domain, ...site.aliases].join(" ");
    const logs = `    access_log ${LOG_DIR}/${site.domain}.access.log;\n    error_log ${LOG_DIR}/${site.domain}.error.log;`;
    const acme = `    location ^~ /.well-known/acme-challenge/ {\n        root ${ACME_WEBROOT};\n        default_type text/plain;\n    }`;
    const tls = hasCert(site);
    const redirect = tls && site.forceHttps;

    let out = `# Managed by kiwi; edit this site from the panel (changes here are overwritten).
server {
    listen 80;
    listen [::]:80;
    server_name ${names};
${logs}

${protectServer(site)}${acme}

${redirect ? "    location / {\n        return 301 https://$host$request_uri;\n    }" : siteBody(site)}
}
`;
    if (tls) {
        const c = certPaths(site.domain);
        out += `
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${names};
    ssl_certificate ${c.fullchain};
    ssl_certificate_key ${c.key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:kiwin_tls:10m;
    ssl_session_timeout 1d;
${site.forceHttps ? '    add_header Strict-Transport-Security "max-age=31536000" always;\n' : ""}${logs}

${protectServer(site)}${acme}

${siteBody(site)}
}
`;
    }
    return out;
}

const WELCOME_HTML = (domain: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${domain}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>${domain}</h1>
<p>This site is served by Kiwin. Replace this page in <code>${siteRoot(domain)}</code>.</p>
</body>
</html>
`;

const WELCOME_PHP = (domain: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${domain}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>${domain}</h1>
<p>Served by Kiwin with PHP <?= htmlspecialchars(PHP_VERSION) ?>. Replace this page in <code>${siteRoot(domain)}</code>.</p>
</body>
</html>
`;

export class KiwiNginx {
    /** Last error from a mutating call, for the UI. */
    static lastError: string | null = null;

    static isInstalled(): boolean {
        return existsSync(NGINX);
    }

    /** Storage layout + the include in the system's nginx config. Idempotent. */
    static ensure(): void {
        for (const d of [SITES_CONF_DIR, LOG_DIR, CERT_DIR, WEB_DIR, join(ACME_WEBROOT, ".well-known", "acme-challenge")]) {
            mkdirSync(d, { recursive: true });
        }
        // Only the nginx master (root) reads configs, keys and opens logs;
        // workers (www-data) need the web roots and challenge files.
        chmodSync(NGINX_DIR, 0o750);
        chmodSync(CERT_DIR, 0o700);
        chmodSync(WEB_DIR, 0o755);
        if (!existsSync(META)) writeFileSync(META, "[]\n", { mode: 0o600 });
        if (!existsSync(PROTECT_META)) writeFileSync(PROTECT_META, JSON.stringify({ trusted: [] }, null, 2) + "\n", { mode: 0o600 });
        const include = includeText();
        if (existsSync("/etc/nginx/conf.d") && (!existsSync(INCLUDE_FILE) || readFileSync(INCLUDE_FILE, "utf8") !== include)) {
            writeFileSync(INCLUDE_FILE, include, { mode: 0o644 });
        }
    }

    static list(): Site[] {
        if (!existsSync(META)) return [];
        try {
            return JSON.parse(readFileSync(META, "utf8")) as Site[];
        } catch {
            return [];
        }
    }

    static get(domain: string): Site | undefined {
        return this.list().find((s) => s.domain === domain);
    }

    static hasCert(site: Site): boolean {
        return hasCert(site);
    }

    static async status() {
        return agent<{ state: string; pid: number | null; uptime: number | null; error: string | null }>(`/units/${UNIT}`);
    }

    /**
     * Create a site. `target` is the upstream URL for "proxy" and the PHP
     * version for "php"; unused for "static".
     */
    static async create(domain: string, aliases: string[], type: SiteType, target = ""): Promise<boolean> {
        this.lastError = null;
        domain = domain.toLowerCase();
        aliases = aliases.map((a) => a.toLowerCase()).filter(Boolean);
        for (const name of [domain, ...aliases]) {
            if (!DOMAIN.test(name)) return this.fail(`Invalid domain: ${name}`);
        }
        if (type === "proxy" && !PROXY.test(target)) return this.fail("Proxy target must look like http://127.0.0.1:3000");
        if (type === "php") {
            if (!KiwiPhp.versions().includes(target)) return this.fail(`PHP ${target || "(none)"} is not installed`);
            try {
                await KiwiPhp.ensure(target);
            } catch (e) {
                return this.fail(`Could not start PHP ${target}: ${(e as Error).message}`);
            }
        }
        const sites = this.list();
        const taken = new Set(sites.flatMap((s) => [s.domain, ...s.aliases]));
        const clash = [domain, ...aliases].find((n) => taken.has(n));
        if (clash) return this.fail(`${clash} is already used by another site`);

        const site: Site = {
            domain,
            aliases,
            type,
            ...(type === "proxy" ? { proxy: target } : {}),
            ...(type === "php" ? { php: target } : {}),
            enabled: true,
            createdAt: new Date().toISOString(),
            protect: { ...DEFAULT_PROTECTION },
        };
        // New static/PHP sites get a welcome page; undo that if nginx rejects the change.
        const siteDir = join(WEB_DIR, domain);
        const createdDir = type !== "proxy" && !existsSync(siteDir);
        if (createdDir) {
            mkdirSync(join(siteDir, WEB_ROOT), { recursive: true, mode: 0o755 });
            const [file, content] = type === "php" ? ["index.php", WELCOME_PHP(domain)] : ["index.html", WELCOME_HTML(domain)];
            writeFileSync(join(siteDir, WEB_ROOT, file), content, { mode: 0o644 });
        }
        const ok = await this.apply([...sites, site]);
        if (!ok && createdDir) rmSync(siteDir, { recursive: true, force: true });
        return ok;
    }

    static async setEnabled(domain: string, enabled: boolean): Promise<boolean> {
        return this.update(domain, (s) => { s.enabled = enabled; });
    }

    static async setForceHttps(domain: string, on: boolean): Promise<boolean> {
        const site = this.get(domain);
        if (on && site && !hasCert(site)) return this.fail("Issue a certificate first");
        return this.update(domain, (s) => { s.forceHttps = on; });
    }

    /** Serve a site through PHP-FPM `version` (e.g. a static site becoming a PHP app's home). */
    static async setPhp(domain: string, version: string): Promise<boolean> {
        if (!KiwiPhp.versions().includes(version)) return this.fail(`PHP ${version} is not installed`);
        try {
            await KiwiPhp.ensure(version);
        } catch (e) {
            return this.fail(`Could not start PHP ${version}: ${(e as Error).message}`);
        }
        return this.update(domain, (s) => {
            s.type = "php";
            s.php = version;
            delete s.proxy;
        });
    }

    /** The user a site's PHP runs as: its own, or www-data in the shared pool. */
    static phpUser(domain: string): number {
        const site = this.get(domain);
        return site?.type === "php" && KiwiPhp.hasSitePools(site.php) && site.uid ? site.uid : wwwDataUid();
    }

    /** Let a site's PHP write everywhere in its folder (apps that update themselves, like WordPress). */
    static giveToPhp(domain: string): number {
        const site = this.get(domain);
        if (site?.type !== "php" || !KiwiPhp.hasSitePools(site.php) || !site.uid) throw new Error(`${domain} has no PHP user of its own`);
        return KiwiPhp.chownTree(join(WEB_DIR, domain), site.uid);
    }

    /** What a PHP site's code may do, and extra folders it may use (see Site.phpAllow). */
    static async setPhpAccess(domain: string, access: { shell?: boolean; files?: boolean; paths?: string[] }): Promise<boolean> {
        const site = this.get(domain);
        if (site?.type !== "php") return this.fail(`${domain} is not a PHP site`);
        for (const p of access.paths ?? []) {
            if (!/^\/[A-Za-z0-9._\/-]{1,200}$/.test(p) || p.split("/").includes("..")) return this.fail(`Invalid folder: ${p}`);
        }
        return this.update(domain, (s) => {
            if (access.shell !== undefined || access.files !== undefined) {
                const allow = { ...s.phpAllow, ...(access.shell !== undefined ? { shell: access.shell } : {}), ...(access.files !== undefined ? { files: access.files } : {}) };
                if (allow.shell || allow.files) s.phpAllow = allow;
                else delete s.phpAllow;
            }
            if (access.paths) {
                if (access.paths.length) s.phpPaths = [...new Set(access.paths)];
                else delete s.phpPaths;
            }
        });
    }

    /**
     * On start: give PHP sites made before per-site pools their own pool. Hand-edited
     * configs keep working: only their fastcgi_pass moves from the shared socket.
     */
    static async migratePhpPools(): Promise<void> {
        const sites = this.list().filter((s) => s.type === "php" && s.enabled && KiwiPhp.hasSitePools(s.php));
        let stale = false;
        const all = this.list();
        for (const s of sites) {
            // Webmail set up before per-site pools: its data folder is outside the site.
            const include = join(siteRoot(s.domain), "include.php");
            const m = existsSync(include) ? /Written by kiwi[^\n]*\n\s*define\('APP_DATA_FOLDER_PATH', '(\/[A-Za-z0-9._\/-]+?)\/?'\)/.exec(readFileSync(include, "utf8")) : null;
            const entry = all.find((x) => x.domain === s.domain)!;
            if (m && !entry.phpPaths?.includes(m[1])) {
                entry.phpPaths = [...(entry.phpPaths ?? []), m[1]];
                stale = true;
            }
            const shared = `unix:${KiwiPhp.socket(s.php!)}`;
            const file = customFile(s.domain);
            if (existsSync(file) && readFileSync(file, "utf8").includes(shared)) {
                writeFileSync(file, readFileSync(file, "utf8").split(shared).join(`unix:${phpSocket(s)}`), { mode: 0o640 });
                stale = true;
            }
            const conf = join(SITES_CONF_DIR, `${s.domain}.conf`);
            // No pool yet also covers websites restored from a backup onto another server.
            if (!s.uid || !KiwiPhp.hasPool(s.php!, s.domain) || !existsSync(conf) || readFileSync(conf, "utf8").includes(shared)) stale = true;
        }
        if (stale && !(await this.apply(all))) console.error(`nginx: moving PHP sites to their own pools failed: ${this.lastError}`);
    }

    /**
     * Turn attack prevention on (or change it) for a site; null switches it off
     * and the site is served exactly as before the feature existed.
     */
    static async setProtection(domain: string, protect: Protection | null): Promise<boolean> {
        if (protect && !(protect.level in LEVELS)) return this.fail(`Unknown protection level: ${protect.level}`);
        return this.update(domain, (s) => {
            if (protect) s.protect = protect;
            else delete s.protect;
        });
    }

    /** Addresses and ranges exempt from every limit, shared by all websites. */
    static trusted(): string[] {
        return readProtectMeta().trusted;
    }

    /** Replace the exempt addresses; applied to nginx the same way a site change is. */
    static async setTrusted(list: string[]): Promise<boolean> {
        this.lastError = null;
        const clean = [...new Set(list.map((t) => t.trim()).filter(Boolean))];
        const bad = clean.find((t) => !TRUSTED.test(t));
        if (bad) return this.fail(`Not an address or range: ${bad}`);
        if (clean.length > 200) return this.fail("Too many addresses (200 at most)");
        this.ensure();
        const before = readFileSync(PROTECT_META, "utf8");
        writeFileSync(PROTECT_META, JSON.stringify({ trusted: clean }, null, 2) + "\n", { mode: 0o600 });
        const ok = await this.apply(this.list());
        if (!ok) writeFileSync(PROTECT_META, before, { mode: 0o600 });
        return ok;
    }

    /** Record an issued certificate (files already written to certPaths). */
    static async setSsl(domain: string, ssl: Site["ssl"]): Promise<boolean> {
        return this.update(domain, (s) => { s.ssl = ssl; });
    }

    /** Remove a site's config and certificate. Its web root in /www/sites is kept. */
    static async remove(domain: string): Promise<boolean> {
        this.lastError = null;
        const sites = this.list();
        if (!sites.some((s) => s.domain === domain)) return this.fail(`No site ${domain}`);
        const ok = await this.apply(sites.filter((s) => s.domain !== domain));
        if (ok) {
            rmSync(certPaths(domain).dir, { recursive: true, force: true });
            rmSync(customFile(domain), { force: true });
        }
        return ok;
    }

    /** `nginx -t` output for the current configuration. */
    static test(): { ok: boolean; output: string } {
        const p = Bun.spawnSync([NGINX, "-t", "-q"], { stdout: "pipe", stderr: "pipe" });
        return { ok: p.exitCode === 0, output: (p.stdout.toString() + p.stderr.toString()).trim() };
    }

    /** Reload nginx through the isol agent (it runs `nginx -t` first, then SIGHUP). */
    static async reload(): Promise<boolean> {
        this.lastError = null;
        try {
            const unit = await this.status();
            if (unit.state !== "running") return true; // picked up on next start
            await agent(`/units/${UNIT}/reload`, {});
            return true;
        } catch (e) {
            return this.fail((e as Error).message);
        }
    }

    static logTail(domain: string, kind: "access" | "error", lines = 50): string {
        if (!DOMAIN.test(domain)) return "";
        try {
            return readFileSync(join(LOG_DIR, `${domain}.${kind}.log`), "utf8").trimEnd().split("\n").slice(-lines).join("\n");
        } catch {
            return "";
        }
    }

    /** A site's nginx config: what is in use, and whether it is hand-edited. */
    static config(domain: string): { text: string; custom: boolean; generated: string } | null {
        const site = this.get(domain);
        if (!site) return null;
        const generated = serverBlocks(site);
        const custom = existsSync(customFile(domain));
        return { text: custom ? readFileSync(customFile(domain), "utf8") : generated, custom, generated };
    }

    /**
     * Use `text` as the site's config (null: back to the generated one), test
     * it with nginx -t and reload; on failure the previous config stays.
     */
    static async saveConfig(domain: string, text: string | null): Promise<boolean> {
        this.lastError = null;
        if (!this.get(domain)) return this.fail(`No site ${domain}`);
        if (text !== null && text.length > MAX_CONFIG) return this.fail("Config too large");
        mkdirSync(CUSTOM_DIR, { recursive: true, mode: 0o750 });
        const file = customFile(domain);
        const before = existsSync(file) ? readFileSync(file, "utf8") : null;
        if (text === null) rmSync(file, { force: true });
        else writeFileSync(file, text.endsWith("\n") ? text : text + "\n", { mode: 0o640 });
        const ok = await this.apply(this.list());
        if (!ok) {
            if (before === null) rmSync(file, { force: true });
            else writeFileSync(file, before, { mode: 0o640 });
        }
        return ok;
    }

    /** On start: move sites still using the old "public" web root to public_html (and rewrite their config). */
    static async migrateWebRoots(): Promise<void> {
        const sites = this.list();
        const stale = sites.some((s) => s.type !== "proxy" && existsSync(join(WEB_DIR, s.domain, "public")) && !existsSync(siteRoot(s.domain)));
        if (stale && !(await this.apply(sites))) console.error(`nginx: moving web roots to ${WEB_ROOT} failed: ${this.lastError}`);
    }

    private static async update(domain: string, change: (s: Site) => void): Promise<boolean> {
        this.lastError = null;
        const sites = this.list();
        const site = sites.find((s) => s.domain === domain);
        if (!site) return this.fail(`No site ${domain}`);
        change(site);
        return this.apply(sites);
    }

    /** Write sites.json + regenerate all server blocks, keep them only if `nginx -t` passes. */
    private static async apply(sites: Site[]): Promise<boolean> {
        if (!this.isInstalled()) return this.fail("nginx is not installed in the system image");
        // ensure() rewrites the shared include from protect.json; keep the old one to undo with.
        const oldInclude = existsSync(INCLUDE_FILE) ? readFileSync(INCLUDE_FILE, "utf8") : null;
        this.ensure();
        // Sites made before the web root was renamed: move public/ to public_html/ once
        // (moved back below if nginx rejects the new configuration).
        const moved: string[] = [];
        for (const site of sites) {
            if (site.type === "proxy") continue;
            const old = join(WEB_DIR, site.domain, "public");
            if (existsSync(old) && !existsSync(siteRoot(site.domain))) {
                renameSync(old, siteRoot(site.domain));
                moved.push(site.domain);
            }
        }

        const backup = new Map<string, string>();
        for (const f of readdirSync(SITES_CONF_DIR)) backup.set(f, readFileSync(join(SITES_CONF_DIR, f), "utf8"));
        const oldMeta = readFileSync(META, "utf8");

        const write = (files: Map<string, string>, meta: string) => {
            for (const f of readdirSync(SITES_CONF_DIR)) if (!files.has(f)) rmSync(join(SITES_CONF_DIR, f));
            for (const [f, content] of files) writeFileSync(join(SITES_CONF_DIR, f), content, { mode: 0o640 });
            writeFileSync(`${META}.tmp`, meta, { mode: 0o600 });
            renameSync(`${META}.tmp`, META);
        };

        const next = new Map<string, string>();
        for (const s of sites) {
            if (s.enabled) next.set(`${s.domain}.conf`, existsSync(customFile(s.domain)) ? readFileSync(customFile(s.domain), "utf8") : serverBlocks(s));
        }
        // PHP sites get a user of their own the first time they need a pool: one
        // no site (or folder left by a removed site) has had.
        const fresh: Site[] = [];
        for (const s of sites) {
            if (s.type !== "php" || !s.enabled || s.uid || !KiwiPhp.hasSitePools(s.php)) continue;
            let max = SITE_UID_MIN - 1;
            for (const o of sites) max = Math.max(max, o.uid ?? 0);
            if (max + 1 >= SITE_UID_MAX) return this.fail("No user ids left for PHP sites");
            for (const d of readdirSync(WEB_DIR)) {
                try {
                    const owner = statSync(join(WEB_DIR, d)).uid;
                    if (owner >= SITE_UID_MIN && owner < SITE_UID_MAX) max = Math.max(max, owner);
                } catch {}
            }
            s.uid = max + 1;
            fresh.push(s);
        }
        const undo = () => {
            write(backup, oldMeta);
            if (oldInclude !== null) writeFileSync(INCLUDE_FILE, oldInclude, { mode: 0o644 });
            for (const d of moved) renameSync(siteRoot(d), join(WEB_DIR, d, "public"));
        };
        // PHP sites' pools change with them: checked first, reloaded only once nginx agrees.
        let pools;
        try {
            pools = KiwiPhp.preparePools(sites);
        } catch (e) {
            return this.fail((e as Error).message);
        }
        write(next, JSON.stringify(sites, null, 2) + "\n");

        const test = this.test();
        if (!test.ok) {
            undo();
            pools.revert();
            return this.fail(`nginx rejected the configuration, nothing changed:\n${test.output}`);
        }
        try {
            await pools.commit();
        } catch (e) {
            undo();
            pools.revert();
            return this.fail(`PHP did not accept the change, nothing changed: ${(e as Error).message}`);
        }
        // What PHP could write as www-data (uploads, caches) it can still write as the site's user.
        const www = wwwDataUid();
        for (const s of fresh) {
            KiwiPhp.chownTree(join(WEB_DIR, s.domain), s.uid!, www);
            for (const p of s.phpPaths ?? []) KiwiPhp.chownTree(p, s.uid!, www);
        }
        return this.reload();
    }

    private static fail(message: string): false {
        this.lastError = message;
        return false;
    }
}
