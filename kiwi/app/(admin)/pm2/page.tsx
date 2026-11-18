import type { Metadata } from "next";
import Link from "next/link";
import { Workflow } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Pm2AppDialog, Pm2LogsDialog } from "@/components/pm2";
import { KiwiPm2, PM2_HOME, type Pm2Process } from "@/lib/pm2";
import { formatBytes, formatUptime } from "@/lib/services";
import { requireUser } from "@/lib/session";
import { installPm2, pm2Op, uninstallPm2 } from "@/app/actions";

export const metadata: Metadata = { title: "PM2" };

const STATUS: Record<string, string> = { online: "badge badge-ok", errored: "badge badge-bad", stopped: "badge", launching: "badge badge-warn" };

export default async function Pm2Page() {
    await requireUser();

    if (!KiwiPm2.isInstalled()) {
        const node = KiwiPm2.hasNode();
        return (
            <>
                <div className="page-head"><div><h1>PM2</h1><p>Process manager for Node.js and Bun apps: keeps them running, restarts them on crashes and after reboots.</p></div></div>
                <section className="card empty-state">
                    <Workflow size={36} aria-hidden />
                    <h2>{node ? "PM2 is not installed" : "PM2 needs Node.js"}</h2>
                    <p>
                        {node
                            ? "Installs PM2 with npm into /www/softwares/pm2. Nothing is written to the system image."
                            : "PM2 itself runs on Node.js (your apps can still use Bun). Install Node.js first."}
                    </p>
                    {node ? (
                        <ActionForm action={installPm2} className="inline-form"><SubmitButton>Install PM2</SubmitButton></ActionForm>
                    ) : (
                        <Link href="/software/nodejs" className="btn btn-primary">Install Node.js</Link>
                    )}
                </section>
            </>
        );
    }

    let procs: Pm2Process[] | null = null;
    let error: string | null = null;
    try {
        procs = await KiwiPm2.list();
    } catch (e) {
        error = (e as Error).message;
    }

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>PM2</h1>
                    <p>PM2 {KiwiPm2.version()} · {procs?.length ?? 0} process{procs?.length === 1 ? "" : "es"} · data in <code>{PM2_HOME}</code></p>
                </div>
                <div className="row">
                    <Link href="/pm2" className="btn btn-secondary">Refresh</Link>
                    <Pm2AppDialog />
                </div>
            </div>

            {error && <p className="notice notice-error" role="alert">Could not talk to PM2: {error}</p>}

            {procs && procs.length === 0 ? (
                <section className="card empty-state">
                    <Workflow size={36} aria-hidden />
                    <h2>No processes yet</h2>
                    <p>Start an app with a command like <code>node server.js</code>, <code>bun run start</code> or <code>npm start</code>.</p>
                    <Pm2AppDialog />
                </section>
            ) : procs && (
                <section className="card table-card">
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th scope="col">Name</th>
                                    <th scope="col">Status</th>
                                    <th scope="col">Command</th>
                                    <th scope="col" className="num">CPU</th>
                                    <th scope="col" className="num">Memory</th>
                                    <th scope="col" className="num">Uptime</th>
                                    <th scope="col" className="num">Restarts</th>
                                    <th scope="col"><span className="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {procs.map((p) => (
                                    <tr key={p.name}>
                                        <td>
                                            <strong>{p.name}</strong>
                                            {p.pid && <div className="hint">pid {p.pid}</div>}
                                        </td>
                                        <td><span className={STATUS[p.status] ?? "badge"}>{p.status}</span></td>
                                        <td>
                                            <code className="truncate" title={p.command}>{p.command}</code>
                                            <div className="hint truncate" title={p.cwd}>{p.cwd}{Object.keys(p.env).length > 0 && ` · ${Object.keys(p.env).length} env`}</div>
                                        </td>
                                        <td className="num">{p.status === "online" ? `${p.cpu}%` : "-"}</td>
                                        <td className="num">{p.status === "online" ? formatBytes(p.memory) : "-"}</td>
                                        <td className="num">{p.uptime === null ? "-" : formatUptime(Math.round(p.uptime / 1000))}</td>
                                        <td className="num">{p.restarts}</td>
                                        <td className="cell-actions">
                                            <div className="item-actions" style={{ justifyContent: "flex-end" }}>
                                                {p.status === "online" ? (
                                                    <>
                                                        <ActionForm action={pm2Op.bind(null, p.name, "restart")}><SubmitButton variant="secondary">Restart</SubmitButton></ActionForm>
                                                        <ActionForm action={pm2Op.bind(null, p.name, "stop")}><SubmitButton variant="secondary">Stop</SubmitButton></ActionForm>
                                                    </>
                                                ) : (
                                                    <ActionForm action={pm2Op.bind(null, p.name, "start")}><SubmitButton>Start</SubmitButton></ActionForm>
                                                )}
                                                <Pm2LogsDialog name={p.name} />
                                                {p.managed && <Pm2AppDialog initial={{ name: p.name, command: p.command, cwd: p.cwd, env: p.env }} />}
                                                <ActionForm action={pm2Op.bind(null, p.name, "delete")}>
                                                    <SubmitButton variant="danger" confirm={`Delete ${p.name} from PM2? The process is stopped; your files stay.`}>Delete</SubmitButton>
                                                </ActionForm>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
                <p className="hint">In the terminal, <code>pm2</code> talks to the same daemon. Processes are saved after every change and restored at boot.</p>
                <ActionForm action={uninstallPm2} className="inline-form">
                    <SubmitButton variant="ghost" confirm="Remove PM2? All its processes are stopped. Your apps' files stay.">Uninstall PM2</SubmitButton>
                </ActionForm>
            </div>
        </>
    );
}
