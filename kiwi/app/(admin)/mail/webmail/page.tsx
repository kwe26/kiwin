import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Inbox } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { MailGate } from "@/components/mail-gate";
import { MasterPasswordDialog } from "@/components/master-password";
import { KiwiMail } from "@/lib/mail";
import { KiwiPhp } from "@/lib/php";
import { requireUser } from "@/lib/session";
import { mailDeployWebmail, mailRevealWebmailAdmin } from "@/app/actions";

export const metadata: Metadata = { title: "Webmail" };

export default async function MailWebmail() {
    await requireUser();
    const gate = MailGate({ title: "Webmail" });
    if (gate) return gate;
    const { hostname, domains } = KiwiMail.settings();
    const installed = KiwiMail.webmailInstalled();
    const url = KiwiMail.webmailUrl();
    const php = KiwiPhp.versions().length > 0;

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Webmail</h1>
                    <p>SnappyMail in the browser, for every mail account on this server.</p>
                </div>
                {url && <a href={url} target="_blank" rel="noreferrer" className="btn btn-primary">Open webmail <ArrowUpRight size={15} aria-hidden /></a>}
            </div>

            {!installed ? (
                <section className="card empty-state">
                    <Inbox size={36} aria-hidden />
                    <h2>SnappyMail is not installed</h2>
                    <p>{php ? "Install it from Software, then publish it here." : "It needs PHP: install PHP from Software first, then SnappyMail."}</p>
                    <Link href={php ? "/software/snappymail" : "/software/php"} className="btn btn-primary">{php ? "Install SnappyMail" : "Install PHP"}</Link>
                </section>
            ) : !hostname || domains.length === 0 ? (
                <section className="card"><p className="hint">Add a mail domain first under <Link href="/mail">Domains</Link>; webmail is published on the mail host name.</p></section>
            ) : (
                <div className="grid sw-body">
                    <section className="card">
                        <h2>{url ? "Published" : "Publish webmail"}</h2>
                        <p className="hint">
                            {url
                                ? <>Webmail is at <a href={url} target="_blank" rel="noreferrer">{url}</a>. Sign in with a mail account&apos;s full address and password. Publish again after updating SnappyMail.</>
                                : <>Puts SnappyMail on <code>{hostname}</code> (a PHP website, created if needed) and connects it to the Mail Server for {domains.join(", ")}.</>}
                        </p>
                        <ActionForm action={mailDeployWebmail} className="inline-form">
                            <SubmitButton variant={url ? "secondary" : "primary"}>{url ? "Publish again" : "Publish webmail"}</SubmitButton>
                        </ActionForm>
                        {url && !url.startsWith("https") && (
                            <p className="notice notice-error">Not on HTTPS yet: passwords would cross the network in plain text. Get a certificate in <Link href="/mail/config">Config</Link>.</p>
                        )}
                    </section>
                    <section className="card">
                        <h2>SnappyMail admin</h2>
                        <p className="hint">Themes, plugins and limits live in SnappyMail&apos;s own admin panel. Domains are set up by kiwi.</p>
                        {url ? (
                            <div className="row">
                                <a href={`${url}/?admin`} target="_blank" rel="noreferrer" className="btn btn-secondary">Admin panel <ArrowUpRight size={15} aria-hidden /></a>
                                <MasterPasswordDialog action={mailRevealWebmailAdmin} label="Admin password" title="SnappyMail admin" variant="ghost" />
                            </div>
                        ) : <p className="hint">Available once published.</p>}
                    </section>
                </div>
            )}
        </>
    );
}
