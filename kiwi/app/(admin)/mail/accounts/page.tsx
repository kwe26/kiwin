import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { MailGate } from "@/components/mail-gate";
import { MasterPasswordDialog } from "@/components/master-password";
import { KiwiMail, type MailAccount } from "@/lib/mail";
import { requireUser } from "@/lib/session";
import { mailCreateAccount, mailDeleteAccount, mailSetPassword } from "@/app/actions";

export const metadata: Metadata = { title: "Mail accounts" };

export default async function MailAccounts() {
    await requireUser();
    const gate = MailGate({ title: "Mail accounts" });
    if (gate) return gate;
    const { hostname, domains } = KiwiMail.settings();
    let accounts: MailAccount[] = [];
    let error: string | null = null;
    try {
        accounts = KiwiMail.accounts();
    } catch (e) {
        error = (e as Error).message;
    }
    const tls = !!KiwiMail.certificate();

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Mail accounts</h1>
                    <p>Mailboxes on this server. Users sign in with their full address.</p>
                </div>
            </div>

            {domains.length === 0 ? (
                <section className="card"><p className="hint">Add a mail domain first under <Link href="/mail">Domains</Link>.</p></section>
            ) : (
                <div className="grid fw-grid">
                    <section className="card table-card">
                        <div className="table-wrap">
                            {error && <p className="notice notice-error" style={{ margin: 16 }}>{error}</p>}
                            <table className="table">
                                <thead>
                                    <tr>
                                        <th scope="col">Address</th>
                                        <th scope="col">Mailbox</th>
                                        <th scope="col"><span className="sr-only">Actions</span></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {accounts.length === 0 && <tr><td colSpan={3} className="empty">No accounts yet.</td></tr>}
                                    {accounts.map((a) => (
                                        <tr key={a.email}>
                                            <td><strong>{a.email}</strong></td>
                                            <td>{a.mailbox ? <span className="badge badge-ok">yes</span> : <span className="badge badge-warn">login only</span>}</td>
                                            <td className="cell-actions">
                                                <div className="item-actions" style={{ justifyContent: "flex-end" }}>
                                                    <MasterPasswordDialog
                                                        action={mailSetPassword.bind(null, a.email)}
                                                        label="Password"
                                                        icon="refresh"
                                                        variant="ghost"
                                                        title={`New password for ${a.email}`}
                                                        intro="Sets a new password. Mail apps signed in with the old one must sign in again."
                                                        submitLabel="Change password"
                                                        fields={
                                                            <label><span className="label-text">New password <span className="opt">(empty = generate)</span></span>
                                                                <input type="password" name="new_password" autoComplete="new-password" minLength={10} />
                                                            </label>
                                                        }
                                                    />
                                                    <ActionForm action={mailDeleteAccount.bind(null, a.email)}>
                                                        <SubmitButton variant="danger" confirm={`Delete ${a.email} and all its mail? This can't be undone.`}>Delete</SubmitButton>
                                                    </ActionForm>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <div className="stack" style={{ gap: 16 }}>
                        <section className="card">
                            <h2>New account</h2>
                            <ActionForm action={mailCreateAccount} className="stack" resetOnSuccess>
                                <label>Address
                                    <input type="email" name="email" placeholder={`name@${domains[0]}`} required autoCapitalize="none" spellCheck={false} />
                                </label>
                                <label><span className="label-text">Password <span className="opt">(empty = generate)</span></span>
                                    <input type="password" name="password" autoComplete="new-password" minLength={10} />
                                </label>
                                <div className="row"><SubmitButton>Create account</SubmitButton></div>
                            </ActionForm>
                        </section>
                        <section className="card">
                            <h2>Mail app settings</h2>
                            <p className="hint">For Thunderbird, Outlook, phones… Username is the full address.</p>
                            <dl className="dl">
                                <dt>Incoming (IMAP)</dt><dd><code>{hostname}</code> port <strong>993</strong> SSL/TLS (or 143 STARTTLS)</dd>
                                <dt>Outgoing (SMTP)</dt><dd><code>{hostname}</code> port <strong>465</strong> SSL/TLS (or 587 STARTTLS)</dd>
                                <dt>Password</dt><dd>Normal password</dd>
                            </dl>
                            {!tls && <p className="notice notice-error">Mail apps can&apos;t sign in until the host name has a certificate: see <Link href="/mail/config">Config</Link>. Webmail works without it.</p>}
                        </section>
                    </div>
                </div>
            )}
        </>
    );
}
