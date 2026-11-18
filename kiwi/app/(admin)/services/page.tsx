import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { KiwiServices, formatUptime } from "@/lib/services";
import { requireUser } from "@/lib/session";
import { serviceAction } from "@/app/actions";

export const metadata: Metadata = { title: "Services" };

const BADGE: Record<string, string> = { running: "badge badge-ok", failed: "badge badge-bad", backoff: "badge badge-warn" };

export default async function Services() {
    await requireUser();
    const units = await KiwiServices.list();

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Services</h1>
                    <p>Services run inside the isolation and are defined in <code>/etc/isol/*.json</code>.</p>
                </div>
                <Link href="/services" className="btn btn-secondary">Refresh</Link>
            </div>
            <section className="card">
                <div className="list">
                    {units.length === 0 && <p className="empty">No services found. Is the isol agent reachable?</p>}
                    {units.map((u) => {
                        const locked = KiwiServices.isProtected(u.name);
                        const running = u.state === "running";
                        return (
                            <div className="item" key={u.name}>
                                <div className="item-main">
                                    <div className="item-title">
                                        {u.name}
                                        <span className={BADGE[u.state] ?? "badge"}>{u.state}</span>
                                        {!u.enabled && <span className="badge">autostart off</span>}
                                    </div>
                                    <div className="item-sub">
                                        {u.description}
                                        {u.pid ? ` · pid ${u.pid}, up ${formatUptime(u.uptime)}` : ""}
                                        {u.restarts ? ` · ${u.restarts} restart${u.restarts === 1 ? "" : "s"} in the last minute` : ""}
                                    </div>
                                    {u.error && <div className="item-sub" style={{ color: "var(--accent)" }}>{u.error}</div>}
                                    {locked && <div className="item-sub">Runs this panel, so it can&apos;t be stopped from here.</div>}
                                </div>
                                <div className="item-actions">
                                    <Link href={`/services/${encodeURIComponent(u.name)}/logs`} className="btn btn-ghost">Logs</Link>
                                    {!locked && !running && (
                                        <ActionForm action={serviceAction.bind(null, u.name, "start")}><SubmitButton variant="secondary">Start</SubmitButton></ActionForm>
                                    )}
                                    {!locked && (
                                        <ActionForm action={serviceAction.bind(null, u.name, "restart")}><SubmitButton variant="secondary">Restart</SubmitButton></ActionForm>
                                    )}
                                    {!locked && running && (
                                        <ActionForm action={serviceAction.bind(null, u.name, "stop")}>
                                            <SubmitButton variant="danger" confirm={`Stop ${u.name}?`}>Stop</SubmitButton>
                                        </ActionForm>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>
        </>
    );
}
