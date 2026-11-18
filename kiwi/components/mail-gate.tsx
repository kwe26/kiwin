import Link from "next/link";
import { Mail } from "lucide-react";
import { KiwiMail } from "@/lib/mail";

/** "Install the Mail Server" card, or null once it is installed. */
export function MailGate({ title }: { title: string }) {
    if (KiwiMail.isInstalled()) return null;
    return (
        <>
            <div className="page-head"><h1>{title}</h1></div>
            <section className="card empty-state">
                <Mail size={36} aria-hidden />
                <h2>The Mail Server is not installed</h2>
                <p>Install it from Software: SMTP, IMAP, DKIM, SPF and DMARC in one service, with everything stored in /www/apps/mail.</p>
                <Link href="/software/mail" className="btn btn-primary">Open in Software</Link>
            </section>
        </>
    );
}

export const STATE_BADGE: Record<string, string> = { running: "badge badge-ok", failed: "badge badge-bad", backoff: "badge badge-warn" };
