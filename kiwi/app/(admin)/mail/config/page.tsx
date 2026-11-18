import type { Metadata } from "next";
import Link from "next/link";
import { Check, Lock, X } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { MailGate, STATE_BADGE } from "@/components/mail-gate";
import { KiwiAcme } from "@/lib/acme";
import { KiwiMail } from "@/lib/mail";
import { requireUser } from "@/lib/session";
import { mailIssueCertificate, mailOpenPorts, mailRestart, mailSetHostname } from "@/app/actions";

export const metadata: Metadata = { title: "Mail config" };

const Yes = ({ ok, yes, no }: { ok: boolean | null; yes: string; no: string }) =>
    ok === null ? <span className="hint">-</span>
        : ok ? <span className="badge badge-ok"><Check size={12} aria-hidden /> {yes}</span>
            : <span className="badge badge-bad"><X size={12} aria-hidden /> {no}</span>;

export default async function MailConfig() {
    await requireUser();
    const gate = MailGate({ title: "Mail config" });
    if (gate) return gate;
    const settings = KiwiMail.settings();
    const status = await KiwiMail.status();
    const cert = KiwiMail.certificate();
    const ports = await KiwiMail.checkPorts();

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Mail config</h1>
                    <p><span className={STATE_BADGE[status?.state ?? ""] ?? "badge"}>Mail Server {status?.state ?? "not started"}</span>{status?.error ? ` · ${status.error}` : ""}</p>
                </div>
                <div className="row">
                    <Link href="/services/mail/logs" className="btn btn-ghost">Logs</Link>
                    {KiwiMail.configured() && <ActionForm action={mailRestart} className="inline-form"><SubmitButton variant="secondary">Restart</SubmitButton></ActionForm>}
                </div>
            </div>

            <div className="grid sw-body">
                <div className="stack" style={{ gap: 16 }}>
                    <section className="card table-card">
                        <div className="table-toolbar tm-toolbar">
                            <div>
                                <h2>Ports</h2>
                                <p className="hint">
                                    Public IP {ports.publicIp ? <code>{ports.publicIp}</code> : "unknown"} · firewall {ports.firewallEnabled ? "on" : "off"}.
                                    &quot;Reachable&quot; tries the public IP from this server; behind home NAT it can fail even when open.
                                </p>
                            </div>
                            {ports.firewallEnabled && (
                                <ActionForm action={mailOpenPorts} className="inline-form"><SubmitButton>Open mail ports</SubmitButton></ActionForm>
                            )}
                        </div>
                        <div className="table-wrap">
                            <table className="table">
                                <thead>
                                    <tr><th scope="col">Port</th><th scope="col">Used for</th><th scope="col">Listening</th><th scope="col">Firewall</th><th scope="col">Reachable</th></tr>
                                </thead>
                                <tbody>
                                    {ports.ports.map((p) => (
                                        <tr key={p.port}>
                                            <td><strong>{p.port}</strong> <span className="hint">{p.name}</span></td>
                                            <td>{p.use}</td>
                                            <td><Yes ok={p.listening} yes="yes" no={p.port === 25 || cert ? "no" : "needs certificate"} /></td>
                                            <td><Yes ok={p.allowed} yes="allowed" no="blocked" /></td>
                                            <td><Yes ok={p.reachable} yes="yes" no="no" /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className="hint" style={{ padding: "12px 16px" }}>
                            Sending to other servers (outbound port 25): <Yes ok={ports.outbound25} yes="works" no="blocked" />
                            {!ports.outbound25 && " Many hosting providers block it by default; ask yours to unblock port 25, or mail you send won't leave this server."}
                        </p>
                    </section>
                </div>

                <div className="stack" style={{ gap: 16 }}>
                    <section className="card">
                        <h2>Host name</h2>
                        <p className="hint">This server&apos;s mail name: the MX target of every domain, the TLS certificate and the webmail address.</p>
                        <ActionForm action={mailSetHostname} className="stack">
                            <label>Host name<input type="text" name="hostname" defaultValue={settings.hostname} placeholder="mail.example.com" required autoCapitalize="none" spellCheck={false} /></label>
                            <div className="row"><SubmitButton variant="secondary">Save</SubmitButton></div>
                        </ActionForm>
                    </section>
                    <section className="card">
                        <h2><Lock size={18} aria-hidden /> TLS certificate</h2>
                        {cert ? (
                            <p className="hint">Let&apos;s Encrypt certificate for <code>{settings.hostname}</code>{cert.expiresAt ? `, valid until ${cert.expiresAt.slice(0, 10)}` : ""}. Renewed with the websites&apos; certificates; restart the Mail Server after a renewal.</p>
                        ) : (
                            <p className="hint">Mail apps need TLS to sign in (ports 465, 587, 993, 143). The host name&apos;s A record must point here and port 80 must be reachable.</p>
                        )}
                        {settings.hostname && (
                            <ActionForm action={mailIssueCertificate} className="stack">
                                {!cert && <label><span className="label-text">Email <span className="opt">(expiry notices, optional)</span></span><input type="text" inputMode="email" name="email" defaultValue={KiwiAcme.email()} autoCapitalize="none" spellCheck={false} /></label>}
                                <div className="row"><SubmitButton variant={cert ? "secondary" : "primary"}>{cert ? "Renew now" : "Get certificate"}</SubmitButton></div>
                            </ActionForm>
                        )}
                    </section>
                    <section className="card">
                        <h2>Files</h2>
                        <dl className="dl">
                            <dt>Data</dt><dd><code>/www/apps/mail</code></dd>
                            <dt>Aliases</dt><dd><Link href="/files/edit?path=%2Fwww%2Fapps%2Fmail%2Faliases">/www/apps/mail/aliases</Link></dd>
                            <dt>Config</dt><dd><code>/www/apps/mail/maddy.conf</code> (generated)</dd>
                        </dl>
                    </section>
                </div>
            </div>
        </>
    );
}
