"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, ScrollText, X } from "lucide-react";
import { SubmitButton } from "@/components/forms";
import { savePm2App } from "@/app/actions";
import { FolderInput } from "@/components/folder-picker";

export interface Pm2AppValues {
    name: string;
    command: string;
    cwd: string;
    env: Record<string, string>;
}

function useDialog() {
    const ref = useRef<HTMLDialogElement>(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (open) ref.current?.showModal();
        else ref.current?.close();
    }, [open]);
    return { ref, open, setOpen };
}

/** "New process" / "Edit" button with the process form in a modal. */
export function Pm2AppDialog({ initial }: { initial?: Pm2AppValues }) {
    const d = useDialog();
    return (
        <>
            {initial ? (
                <button type="button" className="btn btn-ghost" title="Edit" aria-label={`Edit ${initial.name}`} onClick={() => d.setOpen(true)}><Pencil size={15} aria-hidden /></button>
            ) : (
                <button type="button" className="btn btn-primary" onClick={() => d.setOpen(true)}><Plus size={16} aria-hidden /> New process</button>
            )}
            <dialog ref={d.ref} className="dialog dialog-wide" aria-label={initial ? `Edit ${initial.name}` : "New process"} onClose={() => d.setOpen(false)}
                onClick={(e) => e.target === e.currentTarget && d.setOpen(false)}>
                {d.open && <AppForm initial={initial} onDone={() => d.setOpen(false)} />}
            </dialog>
        </>
    );
}

function AppForm({ initial, onDone }: { initial?: Pm2AppValues; onDone: () => void }) {
    const router = useRouter();
    const [state, action] = useActionState(savePm2App.bind(null, initial?.name ?? null), {});
    useEffect(() => {
        if (state.ok) {
            router.refresh();
            onDone();
        }
    }, [state, router, onDone]);
    const envText = Object.entries(initial?.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");

    return (
        <form action={action} className="dialog-body">
            <div className="dialog-head">
                <h2>{initial ? `Edit ${initial.name}` : "New process"}</h2>
                <button type="button" className="btn btn-ghost" onClick={onDone} aria-label="Close"><X size={16} aria-hidden /></button>
            </div>
            <div className="dialog-grid">
                <label>Name
                    <input type="text" name="name" defaultValue={initial?.name} placeholder="api" required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}" autoCapitalize="none" spellCheck={false} autoFocus={!initial} />
                </label>
                <label><span className="label-text">Command <span className="opt">(node app.js, npm start)</span></span>
                    <input type="text" name="command" defaultValue={initial?.command} placeholder="bun run start" required autoCapitalize="none" spellCheck={false} className="mono-input" />
                </label>
            </div>
            <label>Working directory
                <FolderInput name="cwd" defaultValue={initial?.cwd || "/www"} placeholder="/www/sites/example.com" />
            </label>
            <label><span className="label-text">Environment <span className="opt">(KEY=VALUE per line)</span></span>
                <textarea name="env" defaultValue={envText} rows={4} placeholder={"PORT=3000\nNODE_ENV=production"} spellCheck={false} className="env-input" />
            </label>
            {state.message && !state.ok && <p className="notice notice-error" role="alert">{state.message}</p>}
            <p className="hint">Restarted when it crashes, and after a reboot.</p>
            <div className="row dialog-actions">
                <button type="button" className="btn btn-ghost" onClick={onDone}>Cancel</button>
                <SubmitButton>{initial ? "Save and restart" : "Start"}</SubmitButton>
            </div>
        </form>
    );
}

/** Logs button: last lines of stdout / stderr in a modal, refreshed every 2s while open. */
export function Pm2LogsDialog({ name }: { name: string }) {
    const d = useDialog();
    const [tab, setTab] = useState<"out" | "err">("out");
    const [logs, setLogs] = useState<{ out: string; err: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const pre = useRef<HTMLPreElement>(null);

    useEffect(() => {
        if (!d.open) return;
        let stop = false;
        const load = async () => {
            const res = await fetch(`/api/pm2/logs?name=${encodeURIComponent(name)}`).catch(() => null);
            if (stop) return;
            const data = res ? await res.json().catch(() => ({})) : {};
            if (res?.ok) {
                setLogs(data);
                setError(null);
            } else setError(data.error ?? "Could not load logs");
            setTimeout(() => !stop && load(), 2000);
        };
        load();
        return () => {
            stop = true;
        };
    }, [d.open, name]);

    // Stick to the bottom like `tail -f`.
    useEffect(() => {
        const el = pre.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [logs, tab]);

    return (
        <>
            <button type="button" className="btn btn-ghost" title="Logs" aria-label={`Logs of ${name}`} onClick={() => d.setOpen(true)}><ScrollText size={15} aria-hidden /></button>
            <dialog ref={d.ref} className="dialog dialog-logs" aria-label={`Logs of ${name}`} onClose={() => d.setOpen(false)}
                onClick={(e) => e.target === e.currentTarget && d.setOpen(false)}>
                {d.open && (
                    <div className="dialog-body">
                        <div className="dialog-head">
                            <h2>{name} logs</h2>
                            <div className="row">
                                <div className="sw-tabs" role="tablist">
                                    <button type="button" role="tab" aria-selected={tab === "out"} className={tab === "out" ? "active" : ""} onClick={() => setTab("out")}>Output</button>
                                    <button type="button" role="tab" aria-selected={tab === "err"} className={tab === "err" ? "active" : ""} onClick={() => setTab("err")}>Errors</button>
                                </div>
                                <button type="button" className="btn btn-ghost" onClick={() => d.setOpen(false)} aria-label="Close"><X size={16} aria-hidden /></button>
                            </div>
                        </div>
                        {error && <p className="notice notice-error">{error}</p>}
                        <pre ref={pre} className="log log-dialog">{logs ? (logs[tab].trim() || "(empty)") : "Loading…"}</pre>
                    </div>
                )}
            </dialog>
        </>
    );
}
