"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Star, Trash2, X } from "lucide-react";
import { SubmitButton } from "@/components/forms";
import { installSoftware, removeSoftware, setDefaultSoftware } from "@/app/actions";
import type { InstallJob, SoftwareVersion } from "@/lib/software";

const active = (j: InstallJob | null) => !!j && j.phase !== "done" && j.phase !== "error";

function formatMB(n: number) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const PHASE: Record<InstallJob["phase"], string> = {
    resolving: "Resolving packages…",
    downloading: "Downloading",
    verifying: "Verifying checksum…",
    unpacking: "Unpacking…",
    installed: "Installed",
    service: "Creating the service…",
    done: "Done",
    error: "Failed",
};

/** Offered when a software can run as a service and doesn't have one yet. */
export interface ServiceOffer {
    defaultPort: number;
    /** Missing runtime requirements (hints); the service can't be created while any is missing. */
    missing: string[];
}

/** Version selector with Install / Make default / Remove, and live install progress. */
export function SoftwareControls({ id, name, versions, installed, current, initialJob, service }: {
    id: string;
    name: string;
    versions: SoftwareVersion[];
    installed: string[];
    current: string | null;
    initialJob: InstallJob | null;
    service: ServiceOffer | null;
}) {
    const router = useRouter();
    const dialog = useRef<HTMLDialogElement>(null);
    const [version, setVersion] = useState(current ?? versions[0]?.version ?? "");
    const [job, setJob] = useState<InstallJob | null>(initialJob);
    const [asService, setAsService] = useState(!!service && service.missing.length === 0);
    const [installState, install] = useActionState(installSoftware.bind(null, id), {});
    const [defaultState, makeDefault] = useActionState(setDefaultSoftware.bind(null, id), {});
    const [removeState, remove] = useActionState(removeSoftware.bind(null, id), {});

    // Poll while an install runs (started here or in another tab).
    useEffect(() => {
        if (installState.ok) dialog.current?.close();
        if (!installState.ok && !active(job)) return;
        let stop = false;
        const tick = async () => {
            const res = await fetch(`/api/software/${id}`).catch(() => null);
            if (!res?.ok || stop) return;
            const data = (await res.json()) as { job: InstallJob | null };
            setJob(data.job);
            if (active(data.job)) setTimeout(tick, 700);
            else router.refresh();
        };
        tick();
        return () => {
            stop = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [installState]);

    const running = active(job);
    const isInstalled = installed.includes(version);
    const pct = job?.total ? Math.min(100, Math.round((job.received / job.total) * 100)) : null;
    const message = [defaultState, removeState].find((s) => s.message && !s.ok)?.message
        ?? (!installState.ok && !service ? installState.message : null)
        ?? (job?.phase === "error" ? `Install failed: ${job.error}` : null);
    const known = new Set(versions.map((v) => v.version));
    const options = [...versions, ...installed.filter((v) => !known.has(v)).map((v) => ({ version: v, url: "" } as SoftwareVersion))];

    return (
        <div className="sw-controls">
            <div className="row" style={{ justifyContent: "flex-end" }}>
                <label className="sr-only" htmlFor="sw-version">Version</label>
                <select id="sw-version" className="sw-version" value={version} onChange={(e) => setVersion(e.target.value)} disabled={running}>
                    {options.map((v) => (
                        <option key={v.version} value={v.version}>
                            {v.version}{v.channel ? ` · ${v.channel}` : ""}{v.version === current ? " · default" : installed.includes(v.version) ? " · installed" : ""}
                        </option>
                    ))}
                </select>
                {running ? null : !isInstalled ? (
                    service ? (
                        <button type="button" className="btn btn-primary" onClick={() => dialog.current?.showModal()}>
                            <Download size={15} aria-hidden /> Install
                        </button>
                    ) : (
                        <form action={install}>
                            <input type="hidden" name="version" value={version} />
                            <SubmitButton><Download size={15} aria-hidden /> Install</SubmitButton>
                        </form>
                    )
                ) : (
                    <>
                        {version !== current && (
                            <form action={makeDefault}><input type="hidden" name="version" value={version} /><SubmitButton variant="secondary"><Star size={15} aria-hidden /> Make default</SubmitButton></form>
                        )}
                        <form action={remove}>
                            <input type="hidden" name="version" value={version} />
                            <SubmitButton variant="danger" confirm={`Remove ${name} ${version}? Its directory under /www/softwares/${id} is deleted.`}>
                                <Trash2 size={15} aria-hidden /> Remove
                            </SubmitButton>
                        </form>
                    </>
                )}
            </div>
            {running && job && (
                <div className="meter-row sw-progress">
                    <div className="meter-head">
                        <span>{job.phase === "downloading" ? `Downloading ${name} ${job.version}…` : PHASE[job.phase]}</span>
                        <span>{job.phase === "downloading" ? `${formatMB(job.received)}${job.total ? ` / ${formatMB(job.total)}` : ""}` : ""}</span>
                    </div>
                    <div className="meter"><span style={{ width: `${job.phase === "downloading" ? pct ?? 5 : 100}%` }} /></div>
                </div>
            )}
            {message && <p className="notice notice-error" role="alert">{message}</p>}

            {service && (
                <dialog ref={dialog} className="dialog" aria-label={`Install ${name}`} onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}>
                    <form action={install} className="dialog-body">
                        <div className="dialog-head">
                            <h2>Install {name} {version}</h2>
                            <button type="button" className="btn btn-ghost" onClick={() => dialog.current?.close()} aria-label="Close"><X size={16} aria-hidden /></button>
                        </div>
                        <input type="hidden" name="version" value={version} />
                        <div className="ssl-box">
                            <label className="check">
                                <input type="checkbox" name="service" checked={asService} disabled={service.missing.length > 0} onChange={(e) => setAsService(e.target.checked)} />
                                <span>Run as a service</span>
                            </label>
                            <p className="hint">Starts {name} now and whenever the system boots, and restarts it if it crashes.</p>
                            {service.missing.map((m) => <p key={m} className="notice notice-error">{m}</p>)}
                            {asService && (
                                <div className="fw-add-row">
                                    <label>Port
                                        <input type="text" name="port" inputMode="numeric" defaultValue={service.defaultPort} pattern="[0-9]{4,5}" title="1024-65535" required />
                                    </label>
                                    <label className="check" style={{ alignSelf: "end", paddingBottom: 10 }}>
                                        <input type="checkbox" name="firewall" defaultChecked />
                                        <span>Allow in firewall</span>
                                    </label>
                                </div>
                            )}
                        </div>
                        {installState.message && !installState.ok && <p className="notice notice-error" role="alert">{installState.message}</p>}
                        <div className="row dialog-actions">
                            <button type="button" className="btn btn-ghost" onClick={() => dialog.current?.close()}>Cancel</button>
                            <SubmitButton><Download size={15} aria-hidden /> {asService ? "Install and start" : "Install"}</SubmitButton>
                        </div>
                    </form>
                </dialog>
            )}
        </div>
    );
}
