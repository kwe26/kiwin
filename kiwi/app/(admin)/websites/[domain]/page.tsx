import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, FolderOpen, Lock, LockOpen, Power, Shield, ShieldCheck, Trash2 } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { HttpsBadge, ProtectionBadge, TypeBadge, siteTarget } from "@/components/site-badges";
import { KiwiAcme } from "@/lib/acme";
import { KiwiNginx, PROTECT_LEVELS, type ProtectLevel } from "@/lib/nginx";
import { requireUser } from "@/lib/session";
import { setSitePhpSecurity, setSiteProtection, setTrustedAddresses, sitePhpWriteAccess, issueCertificate, reloadNginx, removeSite, resetSiteConfig, saveSiteConfig, setForceHttps, setSiteEnabled, testNginx } from "@/app/actions";
import { CodeEditor } from "@/components/code-editor";
import { JobLog } from "@/components/job-log";
import { KiwiJobs } from "@/lib/jobs";
import { KiwiPhp } from "@/lib/php";

type Props = { params: Promise<{ domain: string }>; searchParams: Promise<{ created?: string; job?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    return { title: decodeURIComponent((await params).domain) };
}

export default async function Website({ params, searchParams }: Props) {
    await requireUser();
    const domain = decodeURIComponent((await params).domain);
    const site = KiwiNginx.get(domain);
    if (!site) notFound();
    const flags = await searchParams;
    const secured = KiwiNginx.hasCert(site);
    const url = `${secured ? "https" : "http"}://${site.domain}`;
    const config = KiwiNginx.config(domain)!;
    const protect = site.protect;
    const trusted = KiwiNginx.trusted();
    // The job from the link, or one still running after a reload.
    const linked = flags.job ? KiwiJobs.get(flags.job) : null;
    const job = linked?.key === `ssl:${domain}` ? linked : KiwiJobs.running(`ssl:${domain}`);

    return (
        <>
            <div className="page-head">
                <div>
                    <p><Link href="/websites">← Websites</Link></p>
                    <h1>{site.domain}</h1>
                    <div className="row" style={{ marginTop: 8 }}>
                        <TypeBadge site={site} />
                        <HttpsBadge site={site} secured={secured} />
                        <ProtectionBadge site={site} />
                        <span className="status"><span className={site.enabled ? "dot dot-ok" : "dot"} aria-hidden />{site.enabled ? "Enabled" : "Disabled"}</span>
                    </div>
                </div>
                <a href={url} target="_blank" rel="noreferrer" className="btn btn-secondary"><ArrowUpRight size={16} aria-hidden /> Visit site</a>
            </div>

            {flags.created && <p className="notice notice-ok">Website created.{job ? " Its certificate is being requested below; you can leave this page meanwhile." : ""}</p>}
            {job && (
                <section className="card" style={{ marginTop: 16 }}>
                    <JobLog id={job.id} okMessage={`HTTPS is on for ${domain}.`}
                        failHint="The website works over HTTP. Check that the domain points to this server and port 80 is reachable, then try again in the HTTPS card." />
                </section>
            )}

            <div className="grid grid-2" style={{ marginTop: 16 }}>
                <section className="card">
                    <h2>Overview</h2>
                    <dl className="dl">
                        <dt>Type</dt><dd><TypeBadge site={site} /></dd>
                        <dt>{site.type === "proxy" ? "Proxies to" : "Web root"}</dt><dd><code>{siteTarget(site)}</code></dd>
                        <dt>Aliases</dt><dd>{site.aliases.length ? site.aliases.join(", ") : "None"}</dd>
                        <dt>Created</dt><dd>{new Date(site.createdAt).toUTCString()}</dd>
                    </dl>
                    {site.type !== "proxy" && (
                        <Link href={`/files?path=${encodeURIComponent(`/www/sites/${site.domain}/public_html`)}`} className="btn btn-secondary" style={{ marginTop: 16 }}>
                            <FolderOpen size={16} aria-hidden /> Open in file manager
                        </Link>
                    )}
                </section>

                <section className="card">
                    <h2>{secured ? <><Lock size={17} aria-hidden /> HTTPS</> : <><LockOpen size={17} aria-hidden /> HTTPS</>}</h2>
                    {secured && site.ssl ? (
                        <>
                            <dl className="dl">
                                <dt>Issuer</dt><dd>Let&apos;s Encrypt{site.ssl.staging ? " (staging, not trusted by browsers)" : ""}</dd>
                                <dt>Issued</dt><dd>{new Date(site.ssl.issuedAt).toUTCString()}</dd>
                                <dt>Expires</dt><dd>{new Date(site.ssl.expiresAt).toUTCString()}</dd>
                                <dt>Renewal</dt><dd>Automatic, 30 days before expiry</dd>
                            </dl>
                            <div className="row" style={{ marginTop: 16 }}>
                                <ActionForm action={setForceHttps.bind(null, site.domain, !site.forceHttps)} className="inline-form">
                                    <SubmitButton variant="secondary">{site.forceHttps ? "Stop redirecting HTTP" : "Redirect HTTP to HTTPS"}</SubmitButton>
                                </ActionForm>
                                <ActionForm action={issueCertificate.bind(null, site.domain)} className="inline-form">
                                    <SubmitButton variant="secondary">Renew now</SubmitButton>
                                </ActionForm>
                            </div>
                            <p className="hint" style={{ marginTop: 10 }}>{site.forceHttps ? "HTTP visitors are redirected, and browsers are told to use HTTPS (HSTS)." : "The site answers on both HTTP and HTTPS."}</p>
                        </>
                    ) : (
                        <>
                            <p className="hint">Get a free certificate from Let&apos;s Encrypt{KiwiAcme.isStaging() ? " (staging)" : ""}. {site.domain}{site.aliases.length ? " and its aliases" : ""} must point to this server, and port 80 must be reachable from the internet.</p>
                            <ActionForm action={issueCertificate.bind(null, site.domain)} className="stack">
                                <label><span className="label-text">Email for expiry notices <span className="opt">(optional)</span></span>
                                    <input type="text" inputMode="email" name="email" defaultValue={KiwiAcme.email()} placeholder="you@example.com" autoCapitalize="none" spellCheck={false} />
                                </label>
                                <SubmitButton>Issue certificate</SubmitButton>
                            </ActionForm>
                        </>
                    )}
                </section>
            </div>

            {site.type === "php" && (
                <section className="card" style={{ marginTop: 16 }}>
                    <h2><ShieldCheck size={17} aria-hidden /> PHP security</h2>
                    {KiwiPhp.hasSitePools(site.php) ? (
                        <>
                            <p className="hint">This site runs PHP {site.php} in its own pool, as its own user (id {site.uid ?? "assigned on save"}), which can&apos;t enter other PHP sites&apos; folders. If the site is ever broken into, the switches below limit what the intruder&apos;s code can do. The <code>php</code> command in the terminal is not limited.</p>
                            <ActionForm action={setSitePhpSecurity.bind(null, site.domain)} className="stack">
                                <label className="check">
                                    <input type="checkbox" name="blockShell" defaultChecked={!site.phpAllow?.shell} />
                                    <span>Block shell commands <span className="opt">· exec, system, shell_exec, passthru, proc_open, popen, putenv and similar</span></span>
                                </label>
                                <label className="check">
                                    <input type="checkbox" name="jail" defaultChecked={!site.phpAllow?.files} />
                                    <span>Keep PHP inside this site&apos;s folder <span className="opt">· /www/sites/{site.domain}{site.phpPaths?.length ? `, ${site.phpPaths.join(", ")}` : ""}</span></span>
                                </label>
                                <div><SubmitButton variant="secondary">Save</SubmitButton></div>
                            </ActionForm>
                            <p className="hint" style={{ marginTop: 10 }}>Untick one only for an app that needs it (some call exec for image tools or backups). Custom nginx configuration must keep the <code>fastcgi_pass</code> line of the generated one.</p>
                            <div className="sw-service">
                                <p className="hint">Files you upload belong to root, so PHP can read but not change them. Apps that update themselves or store uploads (WordPress and most others) need to write: this hands every file in the site&apos;s folder to its PHP user. In the terminal: <code>chown -R {site.uid ?? "id"}:{site.uid ?? "id"} folder</code>.</p>
                                <ActionForm action={sitePhpWriteAccess.bind(null, site.domain)} className="inline-form">
                                    <SubmitButton variant="secondary" confirm={`Let PHP change every file in /www/sites/${site.domain}?`}>Let PHP write to this site&apos;s files</SubmitButton>
                                </ActionForm>
                            </div>
                        </>
                    ) : (
                        <p className="hint">PHP {site.php} comes from the system image, so this site shares its pool and these protections don&apos;t apply. Install PHP from Software and switch the site to it.</p>
                    )}
                </section>
            )}

            <section className="card" style={{ marginTop: 16 }}>
                <h2><Shield size={17} aria-hidden /> Attack prevention</h2>
                <p className="hint">
                    Spam and brute-force traffic looks like one source asking for far more, far faster, than a person browsing does. nginx counts requests
                    per visitor for this website alone and answers the excess with <code>429 Too Many Requests</code> instead of running the site for it.
                    A normal page load — a document plus its images, styles and scripts — arrives in one burst and is never slowed down.
                    {config.custom && " This website has a hand-edited configuration, so these settings don't reach it until it is reset to the generated one."}
                </p>
                <ActionForm action={setSiteProtection.bind(null, site.domain)} className="stack">
                    <label><span className="label-text">How much one visitor may ask for</span>
                        <select name="level" defaultValue={protect?.level ?? "off"}>
                            <option value="off">Off · no limits at all</option>
                            {(Object.keys(PROTECT_LEVELS) as ProtectLevel[]).map((l) => (
                                <option key={l} value={l}>
                                    {l[0].toUpperCase() + l.slice(1)} · {PROTECT_LEVELS[l].label}, {PROTECT_LEVELS[l].conn} connections at a time
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="check">
                        <input type="checkbox" name="blockTools" defaultChecked={protect ? !!protect.blockTools : true} />
                        <span>Refuse known attack tools <span className="opt">· sqlmap, nikto, nuclei, wpscan and similar scanners, by User-Agent. Browsers, feed readers and search engine crawlers are not touched.</span></span>
                    </label>
                    <label className="check">
                        <input type="checkbox" name="blockProbes" defaultChecked={protect ? !!protect.blockProbes : true} />
                        <span>Refuse probes for secrets <span className="opt">· <code>.env</code>, <code>.git</code>, <code>.ssh</code>, leftover <code>wp-config.php.bak</code>, database dumps and key files.</span></span>
                    </label>
                    {site.type === "php" && (
                        <label className="check">
                            <input type="checkbox" name="protectLogin" defaultChecked={protect ? !!protect.protectLogin : true} />
                            <span>Slow down password guessing <span className="opt">· 20 tries a minute per visitor on <code>wp-login.php</code>, <code>xmlrpc.php</code> and similar login endpoints.</span></span>
                        </label>
                    )}
                    <div><SubmitButton variant="secondary">Save</SubmitButton></div>
                </ActionForm>
                <p className="hint" style={{ marginTop: 10 }}>
                    Start at Standard; move to Strict only for a site under attack, and to Lenient if an app of yours (a dashboard polling an API, say) is being refused.
                    Refusals are logged as <code>limiting requests</code> in the error log above, so you can see whether real traffic is hitting them.
                </p>
                <div className="sw-service">
                    <p className="hint">Addresses that no limit applies to — your office, an uptime monitor, a payment provider&apos;s callbacks. One per line, as an address or a range (<code>203.0.113.7</code>, <code>203.0.113.0/24</code>). This list is shared by every website.</p>
                    <ActionForm action={setTrustedAddresses} className="stack">
                        <label><span className="label-text">Never limited <span className="opt">(optional)</span></span>
                            <textarea name="trusted" rows={3} defaultValue={trusted.join("\n")} placeholder="203.0.113.7&#10;203.0.113.0/24" autoCapitalize="none" spellCheck={false} />
                        </label>
                        <div><SubmitButton variant="secondary">Save addresses</SubmitButton></div>
                    </ActionForm>
                </div>
            </section>

            <section className="card" style={{ marginTop: 16 }}>
                <h2>Manage</h2>
                <div className="row" style={{ marginTop: 12 }}>
                    <ActionForm action={setSiteEnabled.bind(null, site.domain, !site.enabled)} className="inline-form">
                        <SubmitButton variant="secondary"><Power size={15} aria-hidden /> {site.enabled ? "Disable website" : "Enable website"}</SubmitButton>
                    </ActionForm>
                    <ActionForm action={removeSite.bind(null, site.domain)} className="inline-form">
                        <SubmitButton variant="danger" confirm={`Remove ${site.domain}? nginx stops serving it and its certificate is deleted. Files in /www/sites are kept.`}>
                            <Trash2 size={15} aria-hidden /> Remove website
                        </SubmitButton>
                    </ActionForm>
                </div>
            </section>

            <div className="grid grid-2" style={{ marginTop: 16 }}>
                <section className="card">
                    <h2>Error log</h2>
                    <pre className="log">{KiwiNginx.logTail(site.domain, "error", 80) || "No errors logged."}</pre>
                </section>
                <section className="card">
                    <h2>Access log</h2>
                    <pre className="log">{KiwiNginx.logTail(site.domain, "access", 80) || "No requests yet."}</pre>
                </section>
            </div>
            <section className="card" style={{ marginTop: 16 }}>
                <div className="tm-toolbar" style={{ marginBottom: 12 }}>
                    <div>
                        <h2>nginx configuration {config.custom && <span className="badge badge-warn" style={{ marginLeft: 8 }}>custom</span>}</h2>
                        <p className="hint">
                            {config.custom
                                ? "Hand-edited: used instead of the generated config. Changes made in the panel (aliases, certificates, HTTPS redirect) don't touch it; reset to pick them up."
                                : "Generated from the settings above. Saving an edit makes it this site's custom config. Every save is checked with nginx -t and only then reloaded."}
                        </p>
                    </div>
                    <div className="row">
                        <ActionForm action={testNginx} className="inline-form"><SubmitButton variant="ghost">Test config</SubmitButton></ActionForm>
                        <ActionForm action={reloadNginx} className="inline-form"><SubmitButton variant="ghost">Reload nginx</SubmitButton></ActionForm>
                        {config.custom && (
                            <ActionForm action={resetSiteConfig.bind(null, site.domain)} className="inline-form">
                                <SubmitButton variant="secondary" confirm="Throw away the hand-edited config and use the generated one again?">Reset to generated</SubmitButton>
                            </ActionForm>
                        )}
                    </div>
                </div>
                <div className="site-config-editor">
                    <CodeEditor
                        key={config.text}
                        path={`/www/nginx/sites/${site.domain}.conf`}
                        filename={`${site.domain}.conf`}
                        initial={config.text}
                        onSave={saveSiteConfig.bind(null, site.domain)}
                        saveLabel="Save, test and reload"
                    />
                </div>
            </section>
        </>
    );
}
