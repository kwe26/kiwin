"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";

const ALL = "__all__";

/**
 * Uploads a .sql file straight to /api/databases/import as the request body
 * (streamed into the mysql client, never buffered), with upload progress.
 */
export function SqlImportForm({ databases }: { databases: string[] }) {
    const router = useRouter();
    const file = useRef<HTMLInputElement>(null);
    const [target, setTarget] = useState(ALL);
    const [progress, setProgress] = useState<number | null>(null);
    const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        const f = file.current?.files?.[0];
        if (!f) return;
        if (target === ALL && !window.confirm(`Import ${f.name}? Databases in the file are created, and existing tables with the same names are replaced.`)) return;
        if (target !== ALL && !window.confirm(`Import ${f.name} into ${target}? Tables with the same names are replaced.`)) return;
        setResult(null);
        setProgress(0);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/databases/import?db=${encodeURIComponent(target === ALL ? "all" : target)}`);
        xhr.setRequestHeader("content-type", "application/sql");
        xhr.upload.onprogress = (ev) => ev.lengthComputable && setProgress(ev.loaded / ev.total);
        xhr.upload.onload = () => setProgress(1);
        xhr.onload = () => {
            setProgress(null);
            let data: { ok?: boolean; message?: string; error?: string } = {};
            try {
                data = JSON.parse(xhr.responseText);
            } catch {}
            const ok = xhr.status >= 200 && xhr.status < 300;
            setResult({ ok, message: data.message ?? data.error ?? `Import failed (HTTP ${xhr.status})` });
            if (ok) {
                if (file.current) file.current.value = "";
                router.refresh();
            }
        };
        xhr.onerror = () => {
            setProgress(null);
            setResult({ ok: false, message: "Upload failed (connection lost or the file is too large for a proxy in front of kiwi)" });
        };
        xhr.send(f);
    };

    const busy = progress !== null;
    return (
        <form onSubmit={submit} className="stack">
            <label>Import into
                <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
                    <option value={ALL}>Databases in the file (dump of all databases)</option>
                    {databases.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
            </label>
            <label>SQL file
                <input ref={file} type="file" name="file" accept=".sql,application/sql,text/plain" required disabled={busy} className="file-input" />
            </label>
            {busy && (
                <div className="meter-row">
                    <div className="meter-head"><span>{progress! < 1 ? "Uploading…" : "Importing…"}</span><span>{Math.round(progress! * 100)}%</span></div>
                    <div className="meter"><span style={{ width: `${Math.round(progress! * 100)}%` }} /></div>
                </div>
            )}
            {result && <p className={result.ok ? "notice notice-ok" : "notice notice-error"} role={result.ok ? "status" : "alert"}>{result.message}</p>}
            <div className="row">
                <button type="submit" className="btn btn-primary" disabled={busy}><Upload size={15} aria-hidden /> {busy ? "Working…" : "Import"}</button>
            </div>
        </form>
    );
}
