import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Server } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SoftwareControls } from "@/components/software-controls";
import { SoftwareIcon } from "@/components/software-grid";
import { KiwiSoftware, SOFTWARE_BIN, SOFTWARE_DIR, hasCommand } from "@/lib/software";
import { requireUser } from "@/lib/session";
import { MasterPasswordDialog } from "@/components/master-password";
import { createSoftwareService, removeSoftwareService, repairSoftware, revealServiceSecret, serviceAction } from "@/app/actions";

const STATE_BADGE: Record<string, string> = { running: "badge badge-ok", failed: "badge badge-bad", backoff: "badge badge-warn" };

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const s = KiwiSoftware.get((await params).id);
    return { title: s?.name ?? "Software" };
}

export default async function SoftwareApp({ params }: Props) {
    await requireUser();
    const { id } = await params;
    const s = KiwiSoftware.get(id);
    if (!s) notFound();
    const installed = KiwiSoftware.installed(id);
    const current = KiwiSoftware.current(id);
    if (current) KiwiSoftware.linkCommands(id); // repair links (e.g. after files were moved by hand)
    const commands = KiwiSoftware.commands(id);
    const versions = await KiwiSoftware.versions(s);
    const service = s.service ? await KiwiSoftware.serviceStatus(id) : null;
    const missing = (s.service?.requires ?? []).filter((r) => !hasCommand(r.command)).map((r) => r.hint || `${r.command} is required`);
    const needs = KiwiSoftware.missingNeeds(s);
    const fill = (t: string, port: number) => t.replaceAll("{port}", String(port)).replaceAll("{data}", `/www/apps/${id}`);
    const latest = versions[0];

    return (
        <>
            <Link href="/software" className="back-link"><ArrowLeft size={15} aria-hidden /> Software</Link>
            <section className="card sw-hero">
                <SoftwareIcon src={s.icon} name={s.name} size={96} />
                <div className="sw-hero-text">
                    <h1>{s.name}</h1>
                    <p>{s.summary}</p>
                    {s.developer && <small>{s.developer}</small>}
                </div>
                {needs.length > 0 && !current ? (
                    <div className="sw-controls">
                        <p className="notice notice-error">Install {needs.join(", ")} first. <Link href={`/software/${s.needs![0]}`}>Open</Link></p>
                    </div>
                ) : <SoftwareControls
                    id={s.id}
                    name={s.name}
                    versions={versions}
                    installed={installed}
                    current={current}
                    initialJob={KiwiSoftware.job(id)}
                    service={s.service && !service ? { defaultPort: s.service.defaultPort, missing } : null}
                />}
            </section>

            <div className="grid sw-body">
                <section className="card">
                    <h2>About</h2>
                    <div className="sw-description">
                        {s.description.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}
                    </div>
                    {s.service && current && (
                        <div className="sw-service">
                            <h2><Server size={18} aria-hidden /> Service</h2>
                            {service ? (
                                <>
                                    <p className="hint">
                                        <span className={STATE_BADGE[service.state] ?? "badge"}>{service.state}</span>{" "}
                                        on port <strong>{service.port}</strong>{service.pid ? ` · pid ${service.pid}` : ""}{!service.enabled ? " · not started at boot" : ""}
                                    </p>
                                    {service.error && <p className="notice notice-error">{service.error}</p>}
                                    {s.service.note && <p className="hint">{fill(s.service.note, service.port)}</p>}
                                    <div className="row">
                                        {service.state === "running" ? (
                                            <>
                                                <ActionForm action={serviceAction.bind(null, id, "restart")} className="inline-form"><SubmitButton variant="secondary">Restart</SubmitButton></ActionForm>
                                                <ActionForm action={serviceAction.bind(null, id, "stop")} className="inline-form"><SubmitButton variant="secondary">Stop</SubmitButton></ActionForm>
                                            </>
                                        ) : (
                                            <ActionForm action={serviceAction.bind(null, id, "start")} className="inline-form"><SubmitButton>Start</SubmitButton></ActionForm>
                                        )}
                                        <Link href={`/services/${id}/logs`} className="btn btn-ghost">Logs</Link>
                                        {(s.service.secrets?.length ?? 0) > 0 && (
                                            <MasterPasswordDialog action={revealServiceSecret.bind(null, id)} label="Password" title={`${s.name} password`} variant="ghost" />
                                        )}
                                        <ActionForm action={removeSoftwareService.bind(null, id)} className="inline-form">
                                            <SubmitButton variant="danger" confirm={`Remove the ${s.name} service? It is stopped; its data in /www/apps/${id} is kept.`}>Remove service</SubmitButton>
                                        </ActionForm>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <p className="hint">Run {s.name} in the background on a port you choose; it starts at boot and restarts if it crashes.</p>
                                    {missing.map((m) => <p key={m} className="notice notice-error">{m}</p>)}
                                    {missing.length === 0 && (
                                        <ActionForm action={createSoftwareService.bind(null, id)} className="stack">
                                            <div className="fw-add-row">
                                                <label>Port<input type="text" name="port" inputMode="numeric" defaultValue={s.service.defaultPort} pattern="[0-9]{4,5}" title="1024-65535" required /></label>
                                            </div>
                                            <label className="check"><input type="checkbox" name="firewall" defaultChecked /><span>Allow this port in the firewall</span></label>
                                            <div className="row"><SubmitButton>Create and start service</SubmitButton></div>
                                        </ActionForm>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                    {current && (
                        <>
                            <h2 style={{ marginTop: 20 }}>Usage</h2>
                            <p className="hint">These commands are on PATH in the terminal, over SSH and for services (open a new terminal session after installing):</p>
                            <div className="components" style={{ marginTop: 10 }}>
                                {commands.map((c) => <code key={c} className="chip">{c}</code>)}
                            </div>
                            {(id === "xorg" || s.desktop) && <p className="hint" style={{ marginTop: 12 }}>Open it from <Link href="/desktop">Desktop</Link> in the sidebar{s.desktop ? `: right-click the desktop and choose ${s.desktop.name}` : ""}.</p>}
                            {id === "php" && <p className="hint" style={{ marginTop: 12 }}>Manage settings and extensions in <Link href="/php">PHP</Link>.</p>}
                            {(id === "nodejs" || id === "bun") && (
                                <p className="hint" style={{ marginTop: 12 }}>Keep apps running in the background with <Link href="/pm2">PM2</Link>.</p>
                            )}
                        </>
                    )}
                </section>
                <section className="card">
                    <h2>Details</h2>
                    <dl className="dl">
                        <dt>Default</dt><dd>{current ?? "not installed"}</dd>
                        {installed.length > 0 && <><dt>Installed</dt><dd>{installed.join(", ")}</dd></>}
                        {latest && <><dt>Latest</dt><dd>{latest.version}{latest.channel ? ` (${latest.channel})` : ""}</dd></>}
                        {latest?.size && <><dt>Download</dt><dd>{(latest.size / 1024 / 1024).toFixed(1)} MB</dd></>}
                        {s.category && <><dt>Category</dt><dd>{s.category}</dd></>}
                        {s.license && <><dt>License</dt><dd>{s.license}</dd></>}
                        {s.releases && <><dt>Releases</dt><dd><a href={`https://github.com/${s.releases.github}/releases`} target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={13} aria-hidden /></a></dd></>}
                        {current && (
                            <><dt>Health</dt><dd>
                                <ActionForm action={repairSoftware.bind(null, id)} className="inline-form">
                                    <SubmitButton variant="secondary">{KiwiSoftware.repairable(s) ? "Check & repair" : "Check libraries"}</SubmitButton>
                                </ActionForm>
                            </dd></>
                        )}
                        <dt>Location</dt><dd><code>{SOFTWARE_DIR}/{s.id}</code></dd>
                        <dt>Commands</dt><dd><code>{SOFTWARE_BIN}</code></dd>
                        {s.homepage && (
                            <><dt>Website</dt><dd><a href={s.homepage} target="_blank" rel="noreferrer">{s.homepage.replace(/^https?:\/\//, "")} <ArrowUpRight size={13} aria-hidden /></a></dd></>
                        )}
                    </dl>
                </section>
            </div>
        </>
    );
}
