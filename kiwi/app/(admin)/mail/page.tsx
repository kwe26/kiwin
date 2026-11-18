import type { Metadata } from "next";
import Link from "next/link";
import { Check, CircleAlert, CircleHelp, X } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { CopyButton } from "@/components/copy-button";
import { MailGate, STATE_BADGE } from "@/components/mail-gate";
import { KiwiMail, type MailRecord, type RecordState } from "@/lib/mail";
import { requireUser } from "@/lib/session";
import { mailRemoveDomain } from "@/app/actions";
import { MailAddDomain } from "@/components/mail-add-domain";

export const metadata: Metadata = { title: "Mail domains" };

const STATE: Record<RecordState, { label: string; className: string; icon: typeof Check }> = {
    ok: { label: "OK", className: "badge badge-ok", icon: Check },
    wrong: { label: "Wrong", className: "badge badge-bad", icon: X },
    missing: { label: "Missing", className: "badge badge-warn", icon: CircleAlert },
    unknown: { label: "Can't tell", className: "badge", icon: CircleHelp },
};

function Records({ records }: { records: MailRecord[] }) {
    return (
        <div className="table-wrap">
            <table className="table mail-records">
                <thead>
                    <tr>
                        <th scope="col">Type</th>
                        <th scope="col">Name</th>
                        <th scope="col">Value to set</th>
                        <th scope="col">Now in DNS</th>
                        <th scope="col">Check</th>
                    </tr>
                </thead>
                <tbody>
                    {records.map((r) => {
                        const st = STATE[r.state];
                        const Icon = st.icon;
                        return (
                            <tr key={`${r.type}/${r.name}`}>
                                <td><strong>{r.type}</strong>{r.optional && <div className="hint">recommended</div>}</td>
                                <td><code className="mail-value">{r.name}</code><CopyButton text={r.name} label="Copy name" /></td>
                                <td>
                                    <div className="mail-value-row"><code className="mail-value">{r.value}</code><CopyButton text={r.value} label="Copy value" /></div>
                                    <div className="hint">{r.purpose}</div>
                                </td>
                                <td>{r.found.length ? r.found.map((f) => <code key={f} className="mail-value mail-found">{f}</code>) : <span className="hint">nothing</span>}</td>
                                <td><span className={st.className}><Icon size={12} aria-hidden /> {st.label}</span></td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

export default async function MailDomains() {
    await requireUser();
    const gate = MailGate({ title: "Mail domains" });
    if (gate) return gate;
    const settings = KiwiMail.settings();
    const status = await KiwiMail.status();
    const records = await Promise.all(settings.domains.map(async (d) => [d, await KiwiMail.records(d)] as const));

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Mail domains</h1>
                    <p>
                        <span className={STATE_BADGE[status?.state ?? ""] ?? "badge"}>Mail Server {status?.state ?? "not started"}</span>
                        {settings.hostname && <> · host name <code>{settings.hostname}</code> (<Link href="/mail/config">Config</Link>)</>}
                    </p>
                </div>
                <Link href="/mail" className="btn btn-secondary">Check DNS again</Link>
            </div>

            <section className="card" style={{ marginBottom: 16 }}>
                <h2>Add a domain</h2>
                <p className="hint">Receive and send mail as anything@this-domain. You&apos;ll get the DNS records to set at your domain&apos;s DNS provider.</p>
                <MailAddDomain />
            </section>

            {records.map(([domain, recs]) => {
                const bad = recs.filter((r) => r.state !== "ok" && !r.optional).length;
                return (
                    <section className="card table-card" key={domain} style={{ marginBottom: 16 }}>
                        <div className="table-toolbar tm-toolbar">
                            <div>
                                <h2>{domain}{domain === settings.domains[0] && <span className="badge" style={{ marginLeft: 8 }}>primary</span>}</h2>
                                <p className="hint">{bad ? `${bad} required record${bad === 1 ? "" : "s"} still to fix. DNS changes can take a while to show up.` : "All required records are in place."}</p>
                            </div>
                            <ActionForm action={mailRemoveDomain.bind(null, domain)} className="inline-form">
                                <SubmitButton variant="ghost" confirm={`Stop handling mail for ${domain}? Its accounts and stored mail are kept.`}>Remove</SubmitButton>
                            </ActionForm>
                        </div>
                        <Records records={recs} />
                    </section>
                );
            })}
            {settings.domains.length === 0 && <p className="hint">No mail domains yet.</p>}
        </>
    );
}
