"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Upload, X } from "lucide-react";
import { SubmitButton } from "@/components/forms";
import { restoreBackup } from "@/app/actions";

export interface PartInfo {
    id: string;
    label: string;
    about: string;
}

/** Upload a .tar.gz made by Kiwin, with progress; it is checked before it is listed. */
export function BackupUpload() {
    const router = useRouter();
    const file = useRef<HTMLInputElement>(null);
    const [progress, setProgress] = useState<number | null>(null);
    const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        const f = file.current?.files?.[0];
        if (!f) return;
        setResult(null);
        setProgress(0);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/backups/upload?name=${encodeURIComponent(f.name)}`);
        xhr.setRequestHeader("content-type", "application/gzip");
        xhr.upload.onprogress = (ev) => ev.lengthComputable && setProgress(ev.loaded / ev.total);
        xhr.onload = () => {
            setProgress(null);
            let data: { error?: string } = {};
            try {
                data = JSON.parse(xhr.responseText);
            } catch {}
            const ok = xhr.status >= 200 && xhr.status < 300;
            setResult({ ok, message: ok ? `${f.name} uploaded. Restore it from the list.` : data.error ?? `Upload failed (HTTP ${xhr.status})` });
            if (ok) {
                if (file.current) file.current.value = "";
                router.refresh();
            }
        };
        xhr.onerror = () => {
            setProgress(null);
            setResult({ ok: false, message: "Upload failed (connection lost, or a proxy in front of the panel limits upload size)" });
        };
        xhr.send(f);
    };

    return (
        <form onSubmit={submit} className="stack">
            <input ref={file} type="file" accept=".tar.gz,.tgz,application/gzip" className="file-input" required disabled={progress !== null} aria-label="Backup file" />
            {progress !== null && <progress className="sw-progress" value={progress} max={1} aria-label="Upload progress" />}
            {result && <p className={`notice ${result.ok ? "notice-ok" : "notice-error"}`} role="status">{result.message}</p>}
            <div><button type="submit" className="btn btn-secondary" disabled={progress !== null}><Upload size={15} aria-hidden /> {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : "Upload backup"}</button></div>
        </form>
    );
}

/** Restore button: choose parts, confirm with the master password. */
export function RestoreDialog({ name, parts }: { name: string; parts: PartInfo[] }) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (open) dialog.current?.showModal();
        else dialog.current?.close();
    }, [open]);

    return (
        <>
            <button type="button" className="btn btn-ghost" title="Restore" aria-label={`Restore ${name}`} onClick={() => setOpen(true)}><RotateCcw size={15} aria-hidden /></button>
            <dialog ref={dialog} className="dialog" aria-label={`Restore ${name}`} onClose={() => setOpen(false)} onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
                {open && <RestoreForm name={name} parts={parts} onClose={() => setOpen(false)} />}
            </dialog>
        </>
    );
}

function RestoreForm({ name, parts, onClose }: { name: string; parts: PartInfo[]; onClose: () => void }) {
    const [state, action] = useActionState(restoreBackup.bind(null, name), {});
    return (
        <form action={action} className="dialog-body">
            <div className="dialog-head">
                <h2>Restore backup</h2>
                <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close"><X size={16} aria-hidden /></button>
            </div>
            <p className="folder-path">{name}</p>
            <div className="ssl-box">
                {parts.map((p) => (
                    <label key={p.id} className="check">
                        <input type="checkbox" name="part" value={p.id} defaultChecked />
                        <span>{p.label} <span className="opt">· {p.about}</span></span>
                    </label>
                ))}
            </div>
            <p className="notice notice-error">Files from the backup replace the current ones, and its databases replace databases with the same names. Files that aren&apos;t in the backup are kept.</p>
            <label>Master password
                <input type="password" name="password" autoComplete="current-password" required />
            </label>
            {state.message && !state.ok && <p className="notice notice-error" role="alert">{state.message}</p>}
            <div className="row dialog-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                <SubmitButton><RotateCcw size={15} aria-hidden /> Restore</SubmitButton>
            </div>
        </form>
    );
}
