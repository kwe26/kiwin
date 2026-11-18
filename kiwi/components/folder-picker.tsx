"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, FolderOpen, X } from "lucide-react";
import { listFolders } from "@/app/actions";

/**
 * A text input for a directory with a Browse button that opens a folder list
 * in its own dialog (stacked over the dialog it is in).
 */
export function FolderInput({ name, defaultValue, placeholder }: { name: string; defaultValue?: string; placeholder?: string }) {
    const [value, setValue] = useState(defaultValue ?? "");
    const dialog = useRef<HTMLDialogElement>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (open) dialog.current?.showModal();
        else dialog.current?.close();
    }, [open]);

    return (
        <>
            <div className="input-with-button">
                <input type="text" name={name} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} autoCapitalize="none" spellCheck={false} className="mono-input" />
                <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)} title="Browse folders"><FolderOpen size={15} aria-hidden /> Browse</button>
            </div>
            <dialog ref={dialog} className="dialog dialog-wide" aria-label="Choose a folder" onClose={() => setOpen(false)}
                onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
                {open && <Browser start={value || "/www"} onPick={(p) => { setValue(p); setOpen(false); }} onClose={() => setOpen(false)} />}
            </dialog>
        </>
    );
}

function Browser({ start, onPick, onClose }: { start: string; onPick: (path: string) => void; onClose: () => void }) {
    const [path, setPath] = useState(start);
    const [data, setData] = useState<{ path: string; parent: string | null; dirs: string[] } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (p: string) => {
        const res = await listFolders(p);
        if ("error" in res) {
            setError(res.error);
            // A typed path that doesn't exist: fall back to /www once.
            if (!data && p !== "/www") load("/www");
            return;
        }
        setError(null);
        setData(res);
        setPath(res.path);
    }, [data]);

    useEffect(() => {
        load(start);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="dialog-body">
            <div className="dialog-head">
                <h2>Choose a folder</h2>
                <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close"><X size={16} aria-hidden /></button>
            </div>
            <div className="row" style={{ flexWrap: "nowrap" }}>
                <button type="button" className="btn btn-ghost" disabled={!data?.parent} onClick={() => data?.parent && load(data.parent)} title="Up one level" aria-label="Up one level"><ArrowUp size={15} aria-hidden /></button>
                <span className="folder-path">{path}</span>
            </div>
            {error && <p className="notice notice-error" role="alert">{error}</p>}
            <ul className="folder-list" aria-label={`Folders in ${path}`}>
                {!data ? <li className="empty">Loading…</li>
                    : data.dirs.length === 0 ? <li className="empty">No folders here.</li>
                        : data.dirs.map((d) => (
                            <li key={d}>
                                <button type="button" onClick={() => load(`${data.path === "/" ? "" : data.path}/${d}`)}><Folder size={15} aria-hidden /> {d}</button>
                            </li>
                        ))}
            </ul>
            <div className="row dialog-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={!data} onClick={() => onPick(path)}>Use this folder</button>
            </div>
        </div>
    );
}
