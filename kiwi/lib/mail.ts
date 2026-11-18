import { chmodSync, chownSync, cpSync, existsSync, realpathSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { join } from "node:path";
import { agent } from "./host";
import { KiwiAcme } from "./acme";
import { KiwiFirewall } from "./firewall";
import { DOMAIN, KiwiNginx, certPaths, siteRoot } from "./nginx";
import { KiwiPhp } from "./php";

// Mail for kiwi: Maddy (installed from Software as "mail") runs SMTP,
// submission and IMAP; SnappyMail ("snappymail") is the webmail. Everything is
// on user.img:
//
//   /www/apps/mail/kiwi.json        host name + domains (what the panel edits)
//   /www/apps/mail/maddy.conf       generated from kiwi.json (do not edit)
//   /www/apps/mail/*.db, messages/  accounts and mailboxes (Maddy's state_dir)
//   /www/apps/mail/dkim_keys/       DKIM keys; <domain>_default.dns holds the TXT record
//   /www/apps/mail/aliases          extra aliases, "alias: target" per line
//   /www/services/mail.json         its isol unit
//   /www/apps/snappymail/data       SnappyMail's data, outside the web root
//
// TLS: the mail host name (e.g. mail.example.com) gets a website, which is how
// it gets a Let's Encrypt certificate (HTTP-01 through nginx); the same site
// later serves the webmail. Until there is a certificate only port 25 and the
// webmail's loopback ports are on, as nothing else could log in safely.

export const MAIL_DIR = "/www/apps/mail";
const SETTINGS = join(MAIL_DIR, "kiwi.json");
const CONF = join(MAIL_DIR, "maddy.conf");
const ALIASES = join(MAIL_DIR, "aliases");
const MADDY = "/www/softwares/mail/current/maddy";
const UNIT = "mail";
const UNIT_FILE = `/www/services/${UNIT}.json`;
const SNAPPY_SRC = "/www/softwares/snappymail/current";
const SNAPPY_DATA = "/www/apps/snappymail/data";
/** Plain-text ports on loopback for the webmail on this server (Maddy needs TLS for logins elsewhere). */
const LOCAL_IMAP = 1143;
const LOCAL_SUBMISSION = 1587;

export const MAIL_PORTS = [
    { port: 25, name: "SMTP", use: "Receiving mail from other servers", tls: false },
    { port: 465, name: "Submission (TLS)", use: "Mail apps sending mail", tls: true },
    { port: 587, name: "Submission (STARTTLS)", use: "Mail apps sending mail", tls: true },
    { port: 993, name: "IMAP (TLS)", use: "Mail apps reading mail", tls: true },
    { port: 143, name: "IMAP (STARTTLS)", use: "Mail apps reading mail", tls: true },
] as const;

export interface MailSettings {
    /** Name of this mail server, e.g. mail.example.com (MX target, TLS certificate, webmail). */
    hostname: string;
    /** Mail domains; the first is the primary one (postmaster, bounces). */
    domains: string[];
}

export type RecordState = "ok" | "wrong" | "missing" | "unknown";

/** Called as a long operation moves on, for live progress in the panel. */
export type StepReporter = (step: string, level?: "info" | "warn") => void;

export interface MailRecord {
    type: "A" | "MX" | "TXT" | "PTR";
    name: string;
    value: string;
    purpose: string;
    state: RecordState;
    found: string[];
    /** Not strictly needed for mail to work, but strongly recommended. */
    optional?: boolean;
}

export interface PortCheck {
    port: number;
    name: string;
    use: string;
    /** Something listens on it on this server. */
    listening: boolean;
    /** The firewall lets new connections in (or the firewall is off). */
    allowed: boolean;
    /** A connection to this server's public IP on the port succeeded (null: not tried). */
    reachable: boolean | null;
}

export interface MailAccount {
    email: string;
    /** Has a mailbox (IMAP account) as well as a login. */
    mailbox: boolean;
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

function run(cmd: string[], input?: string) {
    const p = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

/** Public DNS, so checks see what the rest of the internet sees (not a local cache or hosts file). */
function resolver() {
    const r = new Resolver({ timeout: 4000, tries: 2 });
    r.setServers(["1.1.1.1", "8.8.8.8"]);
    return r;
}

const memo = ((globalThis as any).__kiwiMail ??= { ip: null as string | null, ipAt: 0 }) as { ip: string | null; ipAt: number };

/** Try a TCP connection (optionally waiting for a "220" SMTP greeting). */
async function connects(host: string, port: number, expectGreeting = false, timeoutMs = 4000): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok: boolean, s?: { end(): void }) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
                s?.end();
            } catch {}
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        Bun.connect({
            hostname: host,
            port,
            socket: {
                open(s) {
                    if (!expectGreeting) finish(true, s);
                },
                data(s, d) {
                    finish(new TextDecoder().decode(d).startsWith("220"), s);
                },
                error() {
                    finish(false);
                },
                close() {
                    finish(false);
                },
                connectError() {
                    finish(false);
                },
            },
        }).catch(() => finish(false));
    });
}

function listeningPorts(): Set<number> {
    const out = new Set<number>();
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        try {
            for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
                const c = line.trim().split(/\s+/);
                if (c[3] === "0A") out.add(parseInt(c[1].split(":")[1], 16));
            }
        } catch {}
    }
    return out;
}

export class KiwiMail {
    static lastError: string | null = null;

    static isInstalled(): boolean {
        return existsSync(MADDY);
    }

    static webmailInstalled(): boolean {
        return existsSync(join(SNAPPY_SRC, "index.php"));
    }

    static settings(): MailSettings {
        try {
            const s = JSON.parse(readFileSync(SETTINGS, "utf8"));
            return { hostname: String(s.hostname ?? ""), domains: Array.isArray(s.domains) ? s.domains.filter((d: unknown) => typeof d === "string") : [] };
        } catch {
            return { hostname: "", domains: [] };
        }
    }

    private static saveSettings(s: MailSettings) {
        mkdirSync(MAIL_DIR, { recursive: true, mode: 0o750 });
        writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
        renameSync(`${SETTINGS}.tmp`, SETTINGS);
    }

    static configured(s = this.settings()): boolean {
        return !!s.hostname && s.domains.length > 0;
    }

    /** The host name's certificate files, if issued. */
    static certificate(hostname = this.settings().hostname): { fullchain: string; key: string; expiresAt: string | null } | null {
        if (!hostname) return null;
        const c = certPaths(hostname);
        if (!existsSync(c.fullchain) || !existsSync(c.key)) return null;
        return { fullchain: c.fullchain, key: c.key, expiresAt: KiwiNginx.get(hostname)?.ssl?.expiresAt ?? null };
    }

    /** maddy.conf for the current settings (see Maddy's default config, which this follows). */
    private static config(s: MailSettings): string {
        const cert = this.certificate(s.hostname);
        const submissionBody = (local: boolean) => `
    limits {
        all rate 50 1s
    }
    auth &local_authdb${local ? "\n    insecure_auth yes" : ""}
    source $(local_domains) {
        check {
            authorize_sender {
                prepare_email &local_rewrites
                user_to_email identity
            }
        }
        destination postmaster $(local_domains) {
            deliver_to &local_routing
        }
        default_destination {
            modify {
                dkim $(primary_domain) $(local_domains) default
            }
            deliver_to &remote_queue
        }
    }
    default_source {
        reject 501 5.1.8 "Non-local sender domain"
    }
`;
        return `## Generated by kiwi from ${SETTINGS} (Mail > Config). Changes here are overwritten.
## Extra aliases go in ${ALIASES} ("alias@domain: target@domain" per line).

$(hostname) = ${s.hostname}
$(primary_domain) = ${s.domains[0]}
$(local_domains) = ${s.domains.join(" ")}

state_dir ${MAIL_DIR}
runtime_dir /run/maddy
log stderr

${cert ? `tls file ${cert.fullchain} ${cert.key}` : "# No certificate yet (Mail > Config): only port 25 and the webmail's loopback ports are on.\ntls off"}

auth.pass_table local_authdb {
    table sql_table {
        driver sqlite3
        dsn credentials.db
        table_name passwords
    }
}

storage.imapsql local_mailboxes {
    driver sqlite3
    dsn imapsql.db
}

hostname $(hostname)

table.chain local_rewrites {
    optional_step regexp "(.+)\\+(.+)@(.+)" "$1@$3"
    optional_step static {
        entry postmaster postmaster@$(primary_domain)
    }
    optional_step file ${ALIASES}
}

msgpipeline local_routing {
    destination postmaster $(local_domains) {
        modify {
            replace_rcpt &local_rewrites
        }
        deliver_to &local_mailboxes
    }
    default_destination {
        reject 550 5.1.1 "User doesn't exist"
    }
}

smtp tcp://0.0.0.0:25 {
    limits {
        all rate 20 1s
        all concurrency 10
    }
    dmarc yes
    check {
        require_mx_record
        dkim
        spf
    }
    source $(local_domains) {
        reject 501 5.1.8 "Use Submission for outgoing SMTP"
    }
    default_source {
        destination postmaster $(local_domains) {
            deliver_to &local_routing
        }
        default_destination {
            reject 550 5.1.1 "User doesn't exist"
        }
    }
}
${cert ? `
submission tls://0.0.0.0:465 tcp://0.0.0.0:587 {${submissionBody(false)}}
` : ""}
# Webmail on this server: plain text, loopback only.
submission tcp://127.0.0.1:${LOCAL_SUBMISSION} {${submissionBody(true)}}

target.remote outbound_delivery {
    limits {
        destination rate 20 1s
        destination concurrency 10
    }
    mx_auth {
        dane
        mtasts {
            cache fs
            fs_dir mtasts_cache/
        }
        local_policy {
            min_tls_level encrypted
            min_mx_level none
        }
    }
}

target.queue remote_queue {
    target &outbound_delivery
    autogenerated_msg_domain $(primary_domain)
    bounce {
        destination postmaster $(local_domains) {
            deliver_to &local_routing
        }
        default_destination {
            reject 550 5.0.0 "Refusing to send DSNs to non-local addresses"
        }
    }
}
${cert ? `
imap tls://0.0.0.0:993 tcp://0.0.0.0:143 {
    auth &local_authdb
    storage &local_mailboxes
}
` : ""}
imap tcp://127.0.0.1:${LOCAL_IMAP} {
    auth &local_authdb
    storage &local_mailboxes
    insecure_auth yes
}
`;
    }

    /** Directories, the unit (started once a domain exists) and, when configured, maddy.conf. */
    static async provision(): Promise<void> {
        mkdirSync(MAIL_DIR, { recursive: true, mode: 0o750 });
        if (!existsSync(ALIASES)) writeFileSync(ALIASES, "# alias@domain: target@domain\n", { mode: 0o640 });
        await this.apply(false);
    }

    /** Write maddy.conf and the unit; restart Maddy (if configured and `restart`). */
    static async apply(restart = true, step: StepReporter = () => {}): Promise<void> {
        const s = this.settings();
        const ready = this.configured(s);
        if (ready) {
            step("Writing maddy.conf");
            writeFileSync(CONF, this.config(s), { mode: 0o640 });
        }
        mkdirSync("/www/services", { recursive: true, mode: 0o755 });
        writeFileSync(UNIT_FILE, JSON.stringify({
            description: "Mail Server (Maddy): SMTP, submission and IMAP for the domains in Mail > Domains",
            exec: [MADDY, "-config", CONF, "run"],
            pre: [["/bin/mkdir", "-p", "/run/maddy"]],
            cwd: MAIL_DIR,
            enabled: ready,
            restart: "on-failure",
            restartSec: 5,
            restartLimit: 5,
            stopSignal: "SIGTERM",
            stopTimeout: 20,
            ...(ready ? {} : { conditionPathExists: CONF }),
        }, null, 2) + "\n");
        await agent("/daemon-reload", {}).catch(() => {});
        if (ready && restart) {
            const st = await this.status();
            step(st?.state === "running" ? "Restarting the Mail Server" : "Starting the Mail Server");
            await agent(`/units/${UNIT}/${st?.state === "running" ? "restart" : "start"}`, {});
            step("Waiting for the Mail Server to come up");
            await this.waitRunning();
        }
    }

    /** Wait until the unit has stayed up for a moment (a bad config makes it exit right away). */
    private static async waitRunning(timeoutMs = 20_000) {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            const st = await this.status();
            if (st?.state === "running" && (st.uptime ?? 0) >= 2) return;
            if (st?.state === "failed") throw new Error(`The Mail Server stopped: ${st.error ?? "see Mail > Config > Logs"}`);
            await Bun.sleep(500);
        }
        throw new Error("The Mail Server didn't come up in time; see Mail > Config > Logs");
    }

    static async status() {
        return agent<{ state: string; pid: number | null; error: string | null; uptime: number | null }>(`/units/${UNIT}`).catch(() => null);
    }

    // ---- Domains & host name ----

    static async setHostname(hostname: string): Promise<void> {
        hostname = hostname.trim().toLowerCase();
        if (!DOMAIN.test(hostname)) throw new Error("Host name must look like mail.example.com");
        this.saveSettings({ ...this.settings(), hostname });
        await this.apply();
    }

    static async addDomain(domain: string, step: StepReporter = () => {}): Promise<void> {
        domain = domain.trim().toLowerCase();
        if (!DOMAIN.test(domain)) throw new Error("Enter a domain like example.com");
        const s = this.settings();
        if (s.domains.includes(domain)) throw new Error(`${domain} is already a mail domain`);
        step("Saving the domain");
        // First domain: suggest mail.<domain> as the host name.
        const next = { hostname: s.hostname || `mail.${domain}`, domains: [...s.domains, domain] };
        this.saveSettings(next);
        mkdirSync(MAIL_DIR, { recursive: true, mode: 0o750 });
        await this.apply(true, step);
        step("Creating the DKIM key");
        // Maddy makes it when the signing module starts; the record shows once it exists.
        for (let i = 0; i < 40 && !this.dkim(domain); i++) await Bun.sleep(250);
        if (!this.dkim(domain)) step("DKIM key not there yet: it appears once the Mail Server starts", "warn");
        if (this.webmailInstalled()) {
            step("Adding the domain to webmail");
            await this.writeWebmailDomains().catch(() => {});
        }
    }

    static async removeDomain(domain: string): Promise<void> {
        const s = this.settings();
        if (!s.domains.includes(domain)) throw new Error(`${domain} is not a mail domain`);
        this.saveSettings({ ...s, domains: s.domains.filter((d) => d !== domain) });
        if (this.configured()) await this.apply();
        else await agent(`/units/${UNIT}/stop`, {}).catch(() => {});
    }

    /** The DKIM TXT value Maddy generated for a domain (after its first start). */
    static dkim(domain: string): string | null {
        try {
            return readFileSync(join(MAIL_DIR, "dkim_keys", `${domain}_default.dns`), "utf8").trim().replace(/^"|"$/g, "");
        } catch {
            return null;
        }
    }

    /** This server's public IPv4 address, as the internet sees it (cached for 10 minutes). */
    static async publicIp(): Promise<string | null> {
        if (memo.ip && Date.now() - memo.ipAt < 10 * 60_000) return memo.ip;
        for (const url of ["https://api.ipify.org", "https://ipv4.icanhazip.com"]) {
            try {
                const ip = (await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text()).trim();
                if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
                    memo.ip = ip;
                    memo.ipAt = Date.now();
                    return ip;
                }
            } catch {}
        }
        return null;
    }

    /** The DNS records a domain needs, each checked against public DNS. */
    static async records(domain: string): Promise<MailRecord[]> {
        const s = this.settings();
        const host = s.hostname;
        const ip = await this.publicIp();
        const r = resolver();
        const txt = async (name: string) => (await r.resolveTxt(name).catch(() => [] as string[][])).map((parts) => parts.join(""));
        const out: MailRecord[] = [];

        const a = await r.resolve4(host).catch(() => [] as string[]);
        out.push({
            type: "A", name: host, value: ip ?? "(this server's public IP)", purpose: "Points the mail host name at this server",
            found: a, state: !a.length ? "missing" : !ip ? "unknown" : a.includes(ip) ? "ok" : "wrong",
        });

        const mx = await r.resolveMx(domain).catch(() => [] as { exchange: string; priority: number }[]);
        out.push({
            type: "MX", name: domain, value: `10 ${host}`, purpose: "Sends mail for the domain to this server",
            found: mx.map((m) => `${m.priority} ${m.exchange}`),
            state: !mx.length ? "missing" : mx.some((m) => m.exchange.toLowerCase().replace(/\.$/, "") === host) ? "ok" : "wrong",
        });

        const spf = (await txt(domain)).filter((t) => t.toLowerCase().startsWith("v=spf1"));
        out.push({
            type: "TXT", name: domain, value: "v=spf1 mx ~all", purpose: "SPF: lets this server send for the domain",
            found: spf,
            state: !spf.length ? "missing" : spf.length > 1 ? "wrong" : /\b(mx|a)\b/.test(spf[0]) || (ip !== null && spf[0].includes(`ip4:${ip}`)) ? "ok" : "wrong",
        });

        const key = this.dkim(domain);
        const dkimName = `default._domainkey.${domain}`;
        const dk = await txt(dkimName);
        const keyP = key ? /p=([A-Za-z0-9+/=]+)/.exec(key.replace(/\s|"/g, ""))?.[1] : null;
        out.push({
            type: "TXT", name: dkimName, value: key ?? "(created when the Mail Server first starts with this domain)", purpose: "DKIM: proves mail from the domain wasn't forged",
            found: dk,
            state: !dk.length ? "missing" : !keyP ? "unknown" : dk.some((t) => t.replace(/\s/g, "").includes(`p=${keyP}`)) ? "ok" : "wrong",
        });

        const dmarc = await txt(`_dmarc.${domain}`);
        out.push({
            type: "TXT", name: `_dmarc.${domain}`, value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, purpose: "DMARC: tells receivers what to do with forged mail",
            found: dmarc, state: !dmarc.length ? "missing" : dmarc[0].startsWith("v=DMARC1") ? "ok" : "wrong", optional: true,
        });

        if (ip) {
            const ptr = await r.reverse(ip).catch(() => [] as string[]);
            out.push({
                type: "PTR", name: ip, value: host, purpose: "Reverse DNS: set at your hosting provider; big mail providers reject mail without it",
                found: ptr, state: !ptr.length ? "missing" : ptr.some((p) => p.toLowerCase().replace(/\.$/, "") === host) ? "ok" : "wrong", optional: true,
            });
        }
        return out;
    }

    // ---- Ports ----

    static async checkPorts(): Promise<{ ports: PortCheck[]; outbound25: boolean; publicIp: string | null; firewallEnabled: boolean }> {
        const listening = listeningPorts();
        const fw = await KiwiFirewall.info().catch(() => null);
        const ip = await this.publicIp();
        const ports = await Promise.all(MAIL_PORTS.map(async (p) => ({
            port: p.port,
            name: p.name,
            use: p.use,
            listening: listening.has(p.port),
            allowed: !fw || KiwiFirewall.allows(fw, "tcp", p.port),
            // Through the public IP: works on most servers; behind home NAT it may fail even when open.
            reachable: ip && listening.has(p.port) ? await connects(ip, p.port) : null,
        })));
        // Many providers block outgoing port 25; without it no mail leaves this server.
        const outbound25 = await connects("gmail-smtp-in.l.google.com", 25, true, 6000);
        return { ports, outbound25, publicIp: ip, firewallEnabled: !!fw?.enabled };
    }

    /** Allow the mail ports in kiwi's firewall (nothing to do while it is off). */
    static async openPorts(): Promise<number[]> {
        const fw = await KiwiFirewall.info();
        if (!fw.enabled) return [];
        const add = MAIL_PORTS.map((p) => p.port).filter((port) => !KiwiFirewall.allows(fw, "tcp", port));
        if (add.length) {
            const r = await KiwiFirewall.update(true, [...fw.rules, ...add.map((port) => ({ port, proto: "tcp" as const, comment: "Mail" }))]);
            if (!r.ok) throw new Error(r.error ?? "Could not update the firewall");
        }
        return add;
    }

    // ---- TLS certificate ----

    /**
     * Let's Encrypt certificate for the host name. Needs a website for it (to
     * answer the HTTP check), which is created if missing; then Maddy restarts
     * with the TLS ports on.
     */
    static async issueCertificate(email?: string): Promise<void> {
        const { hostname } = this.settings();
        if (!hostname) throw new Error("Set the mail host name first");
        if (!KiwiNginx.get(hostname)) {
            if (!(await KiwiNginx.create(hostname, [], "static"))) throw new Error(KiwiNginx.lastError ?? `Could not create a website for ${hostname}`);
        }
        await KiwiAcme.request(hostname, email);
        await this.apply();
    }

    // ---- Accounts (Maddy's own tools on its databases) ----

    private static maddy(args: string[]) {
        if (!existsSync(CONF)) throw new Error("Add a mail domain first");
        const r = run([MADDY, "-config", CONF, ...args]);
        if (r.code !== 0) throw new Error((r.err || r.out).split("\n").slice(-2).join(" ") || `maddy exited ${r.code}`);
        return r.out;
    }

    static accounts(): MailAccount[] {
        if (!existsSync(CONF)) return [];
        const logins = this.maddy(["creds", "list"]).split("\n").map((l) => l.trim()).filter(Boolean);
        const boxes = new Set(this.maddy(["imap-acct", "list"]).split("\n").map((l) => l.trim()).filter(Boolean));
        return [...new Set([...logins, ...boxes])].sort().map((email) => ({ email, mailbox: boxes.has(email) }));
    }

    private static checkAccount(email: string) {
        email = email.trim().toLowerCase();
        if (!EMAIL.test(email)) throw new Error("Enter an address like name@example.com");
        const domain = email.split("@")[1];
        if (!this.settings().domains.includes(domain)) throw new Error(`${domain} is not a mail domain here; add it under Domains first`);
        return email;
    }

    static createAccount(email: string, password: string): void {
        email = this.checkAccount(email);
        if (password.length < 10) throw new Error("Password must be at least 10 characters");
        this.maddy(["creds", "create", "--password", password, email]);
        try {
            this.maddy(["imap-acct", "create", email]);
        } catch (e) {
            this.maddy(["creds", "remove", "--yes", email]);
            throw e;
        }
    }

    static setPassword(email: string, password: string): void {
        if (password.length < 10) throw new Error("Password must be at least 10 characters");
        this.maddy(["creds", "password", "--password", password, email]);
    }

    /** Delete the login and the mailbox with all its mail. */
    static deleteAccount(email: string): void {
        const boxes = this.accounts().find((a) => a.email === email);
        if (!boxes) throw new Error(`No account ${email}`);
        if (boxes.mailbox) this.maddy(["imap-acct", "remove", "--yes", email]);
        try {
            this.maddy(["creds", "remove", "--yes", email]);
        } catch {}
    }

    // ---- Webmail (SnappyMail) ----

    /**
     * Put SnappyMail on the mail host name's website (PHP), with its data
     * outside the web root and every mail domain preconfigured to use this
     * server over loopback. Re-run after updates to copy the new version.
     */
    static async deployWebmail(): Promise<string> {
        const { hostname } = this.settings();
        if (!this.webmailInstalled()) throw new Error("Install SnappyMail from Software first");
        if (!hostname) throw new Error("Add a mail domain first (it sets the host name)");
        const php = KiwiPhp.versions()[0];
        if (!php) throw new Error("Install PHP from Software first");
        const site = KiwiNginx.get(hostname);
        if (!site) {
            if (!(await KiwiNginx.create(hostname, [], "php", php))) throw new Error(KiwiNginx.lastError ?? `Could not create ${hostname}`);
        } else if (site.type !== "php") {
            if (!(await KiwiNginx.setPhp(hostname, php))) throw new Error(KiwiNginx.lastError ?? `Could not switch ${hostname} to PHP`);
        }
        // Its data folder is outside the site, which is all PHP may open by default.
        if (!(await KiwiNginx.setPhpAccess(hostname, { paths: [SNAPPY_DATA] }))) throw new Error(KiwiNginx.lastError ?? "Could not set up the webmail site");
        const root = siteRoot(hostname);
        mkdirSync(root, { recursive: true, mode: 0o755 });
        for (const f of ["index.html", "index.php"]) rmSync(join(root, f), { force: true });
        // "current" is a symlink: copy what it points to, not the link (cpSync copies links as links).
        const src = realpathSync(SNAPPY_SRC);
        cpSync(src, root, { recursive: true, force: true, filter: (f) => f !== join(src, "data") && !f.startsWith(join(src, "data") + "/") });
        writeFileSync(join(root, "include.php"), `<?php\n// Written by kiwi (Mail > Webmail): SnappyMail's data lives outside the web root.\ndefine('APP_DATA_FOLDER_PATH', '${SNAPPY_DATA}/');\n`);
        mkdirSync(SNAPPY_DATA, { recursive: true, mode: 0o750 });
        chmodSync("/www/apps", 0o755);
        await this.writeWebmailDomains();
        // The site's PHP user must write its data folder.
        const owner = KiwiNginx.phpUser(hostname);
        run(["chown", "-R", `${owner}:${owner}`, "/www/apps/snappymail"]);
        return `https://${hostname}`;
    }

    /** SnappyMail domain files: every mail domain logs in through this server's loopback ports. */
    static async writeWebmailDomains(): Promise<void> {
        if (!existsSync(SNAPPY_DATA)) return;
        const dir = join(SNAPPY_DATA, "_data_", "_default_", "domains");
        mkdirSync(dir, { recursive: true });
        const ssl = { verify_peer: false, verify_peer_name: false, allow_self_signed: true, SNI_enabled: true, disable_compression: true, security_level: 1 };
        const sasl = ["PLAIN", "LOGIN"];
        for (const domain of this.settings().domains) {
            writeFileSync(join(dir, `${domain}.json`), JSON.stringify({
                IMAP: { host: "127.0.0.1", port: LOCAL_IMAP, type: 0, timeout: 300, shortLogin: false, lowerLogin: true, sasl, ssl },
                SMTP: { host: "127.0.0.1", port: LOCAL_SUBMISSION, type: 0, timeout: 60, shortLogin: false, lowerLogin: true, sasl, ssl, useAuth: true, setSender: false, usePhpMail: false },
                Sieve: { host: "127.0.0.1", port: 4190, type: 0, timeout: 10, shortLogin: false, lowerLogin: true, sasl, ssl, enabled: false },
                whiteList: "",
            }, null, 4) + "\n");
        }
        const wwwData = KiwiNginx.phpUser(this.settings().hostname ?? "");
        try {
            for (const f of readdirSync(dir)) chownSync(join(dir, f), wwwData, wwwData);
        } catch {}
    }

    /** SnappyMail's admin password (it writes one on first visit to /?admin). */
    static webmailAdminPassword(): string | null {
        try {
            return readFileSync(join(SNAPPY_DATA, "_data_", "_default_", "admin_password.txt"), "utf8").trim();
        } catch {
            return null;
        }
    }

    static webmailUrl(): string | null {
        const { hostname } = this.settings();
        const site = hostname ? KiwiNginx.get(hostname) : undefined;
        if (!site || site.type !== "php" || !existsSync(join(siteRoot(hostname), "include.php"))) return null;
        return `${site.ssl ? "https" : "http"}://${hostname}`;
    }
}
