import * as acme from "acme-client";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACME_WEBROOT, KiwiNginx, certPaths } from "./nginx";

// Let's Encrypt certificates for websites, via the HTTP-01 challenge: every
// generated server block serves /.well-known/acme-challenge/ from
// ACME_WEBROOT, so the site must already answer on port 80 for its domains.
//
// KIWI_ACME_STAGING=1 uses Let's Encrypt's staging CA (untrusted test certs,
// generous rate limits) - useful while trying things out.

const ACME_DIR = "/www/nginx/acme";
const ACCOUNT_KEY = join(ACME_DIR, "account.key");
const EMAIL_FILE = join(ACME_DIR, "email");
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISSUE_TIMEOUT_MS = 3 * 60_000;

const staging = () => process.env.KIWI_ACME_STAGING === "1";

async function accountKey(): Promise<Buffer> {
    if (!existsSync(ACCOUNT_KEY)) {
        mkdirSync(ACME_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(ACCOUNT_KEY, await acme.crypto.createPrivateKey(), { mode: 0o600 });
    }
    return readFileSync(ACCOUNT_KEY);
}

export class KiwiAcme {
    static lastError: string | null = null;

    /** Contact email used for the Let's Encrypt account (expiry notices). */
    static email(): string {
        try {
            return readFileSync(EMAIL_FILE, "utf8").trim();
        } catch {
            return "";
        }
    }

    static isStaging(): boolean {
        return staging();
    }

    /** Issue (or renew) a certificate covering the site's domain and aliases. */
    static async issue(domain: string, email = this.email(), out: (line: string) => void = () => {}): Promise<boolean> {
        this.lastError = null;
        try {
            await this.request(domain, email, out);
            return true;
        } catch (e) {
            return this.fail((e as Error).message);
        }
    }

    /** Same as issue(), throwing instead: for background jobs, which run side by side. */
    static async request(domain: string, email = this.email(), out: (line: string) => void = () => {}): Promise<void> {
        const site = KiwiNginx.get(domain);
        if (!site) throw new Error(`No site ${domain}`);
        if (!site.enabled) throw new Error("Enable the site first: Let's Encrypt checks it over HTTP");
        if (email && !EMAIL.test(email)) throw new Error("That email address doesn't look right");
        KiwiNginx.ensure();
        if (email) {
            mkdirSync(ACME_DIR, { recursive: true, mode: 0o700 });
            writeFileSync(EMAIL_FILE, email + "\n", { mode: 0o600 });
        }

        const challengeDir = join(ACME_WEBROOT, ".well-known", "acme-challenge");
        const directoryUrl = staging() ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
        // acme-client retries unreachable servers with long backoff and an
        // unhelpful error; check reachability first so the panel answers quickly.
        out(`Contacting Let's Encrypt${staging() ? " (staging)" : ""}`);
        try {
            await fetch(directoryUrl, { signal: AbortSignal.timeout(10_000) });
        } catch {
            throw new Error("Can't reach Let's Encrypt. Check that this server has outbound internet access (HTTPS) and working DNS.");
        }
        const names = [domain, ...site.aliases];
        let cert: string;
        let key: Buffer;
        try {
            const client = new acme.Client({ directoryUrl, accountKey: await accountKey() });
            const [k, csr] = await acme.crypto.createCsr({ commonName: domain, altNames: names });
            key = k;
            out(`Requesting a certificate for ${names.join(", ")}`);
            const issued = client.auto({
                csr,
                email: email || undefined,
                termsOfServiceAgreed: true,
                challengePriority: ["http-01"],
                challengeCreateFn: async (authz, challenge, keyAuthorization) => {
                    writeFileSync(join(challengeDir, challenge.token), keyAuthorization, { mode: 0o644 });
                    out(`Let's Encrypt is checking http://${authz.identifier.value}/.well-known/acme-challenge/…`);
                },
                challengeRemoveFn: async (authz, challenge) => {
                    rmSync(join(challengeDir, challenge.token), { force: true });
                    out(`${authz.identifier.value}: checked`);
                },
            });
            // acme-client keeps polling a failing order with backoff; never let that look like a hang.
            let timer: Timer | undefined;
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`no answer after ${ISSUE_TIMEOUT_MS / 60_000} minutes. Check that ${names.join(", ")} point to this server and port 80 is open`)), ISSUE_TIMEOUT_MS);
            });
            try {
                cert = await Promise.race([issued, timeout]);
            } finally {
                clearTimeout(timer);
            }
        } catch (e) {
            throw new Error(`Let's Encrypt: ${(e as Error).message}`);
        }

        const paths = certPaths(domain);
        mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
        writeFileSync(paths.key, key, { mode: 0o600 });
        writeFileSync(paths.fullchain, cert, { mode: 0o644 });
        const info = acme.crypto.readCertificateInfo(cert);
        out(`Certificate issued, valid until ${info.notAfter.toUTCString()}`);
        out("Turning on HTTPS in nginx");
        const ok = await KiwiNginx.setSsl(domain, {
            issuedAt: (info.notBefore ?? new Date()).toISOString(),
            expiresAt: info.notAfter.toISOString(),
            ...(staging() ? { staging: true } : {}),
        });
        if (!ok) throw new Error(KiwiNginx.lastError ?? "Could not enable HTTPS");
        out(`HTTPS is on for ${domain}`);
    }

    /** Renew certificates that expire within 30 days. Returns the domains renewed. */
    static async renewDue(): Promise<string[]> {
        const renewed: string[] = [];
        for (const site of KiwiNginx.list()) {
            if (!site.ssl || !site.enabled) continue;
            if (new Date(site.ssl.expiresAt).getTime() - Date.now() > RENEW_BEFORE_MS) continue;
            if (await this.issue(site.domain)) renewed.push(site.domain);
            else console.error(`[acme] renewing ${site.domain} failed: ${this.lastError}`);
        }
        return renewed;
    }

    private static fail(message: string): false {
        this.lastError = message;
        return false;
    }
}
