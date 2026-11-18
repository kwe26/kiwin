"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, FileArchive, FilePlus, FolderOpen, FolderPlus, Pencil, SquarePen, Trash2, Upload } from "lucide-react";
import { fileCompress, fileExtract, fileMkdir, fileRemove, fileRename, fileTouch, fileUpload } from "@/app/actions";

const ARCHIVE = /\.(7z|zip|rar|tar|gz|tgz|xz|txz|bz2|tbz2?|zst|lzma|cab|iso|arj|lzh|wim|jar|apk|deb|rpm)$/i;
/** "site.tar.gz" -> "site", "photos.zip" -> "photos" */
const stem = (name: string) => name.replace(/\.(tar\.(gz|xz|bz2|zst)|[^.]+)$/i, "") || name;

/** New folder / new file / upload for the current directory. */
export function FileToolbar({ dir }: { dir: string }) {
    const [pending, start] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const upload = useRef<HTMLInputElement>(null);
    const router = useRouter();

    const run = (op: () => Promise<string | null>) => start(async () => {
        const err = await op();
        setError(err);
        if (!err) router.refresh();
    });
    const ask = (label: string, op: (name: string) => Promise<string | null>) => {
        const name = window.prompt(label);
        if (name) run(() => op(name));
    };

    return (
        <div className="stack" style={{ gap: 8 }}>
            <div className="row">
                <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => ask("New folder name", (n) => fileMkdir(dir, n))}>
                    <FolderPlus size={16} aria-hidden /> New folder
                </button>
                <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => ask("New file name", (n) => fileTouch(dir, n))}>
                    <FilePlus size={16} aria-hidden /> New file
                </button>
                <button type="button" className="btn btn-primary" disabled={pending} onClick={() => upload.current?.click()}>
                    <Upload size={16} aria-hidden /> {pending ? "Working…" : "Upload"}
                </button>
                <input
                    ref={upload}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                        const files = e.target.files;
                        if (!files?.length) return;
                        const fd = new FormData();
                        for (const f of files) fd.append("files", f);
                        e.target.value = "";
                        run(() => fileUpload(dir, fd));
                    }}
                />
            </div>
            {error && <p className="notice notice-error" role="alert">{error}</p>}
        </div>
    );
}

/** Per-entry actions in the listing. */
export function FileActions({ path, name, isFile, editable, archiver = false }: {
    path: string;
    name: string;
    isFile: boolean;
    editable: boolean;
    /** 7-Zip is installed: offer Extract / Compress. */
    archiver?: boolean;
}) {
    const [pending, start] = useTransition();
    const router = useRouter();
    const run = (op: () => Promise<string | null>) => start(async () => {
        const err = await op();
        if (err) window.alert(err);
        else router.refresh();
    });

    return (
        <>
            {editable && (
                <Link href={`/files/edit?path=${encodeURIComponent(path)}`} className="btn btn-ghost" title="Edit" aria-label={`Edit ${name}`}><SquarePen size={16} aria-hidden /></Link>
            )}
            {archiver && isFile && ARCHIVE.test(name) && (
                <button
                    type="button" className="btn btn-ghost" title="Extract" aria-label={`Extract ${name}`} disabled={pending}
                    onClick={() => {
                        const folder = window.prompt(`Extract ${name} into the folder`, stem(name));
                        if (folder) run(() => fileExtract(path, folder));
                    }}
                ><FolderOpen size={16} aria-hidden /></button>
            )}
            {archiver && (
                <button
                    type="button" className="btn btn-ghost" title="Compress" aria-label={`Compress ${name}`} disabled={pending}
                    onClick={() => {
                        const archive = window.prompt(`Compress ${name} to (.7z, .zip, .tar.gz, .tar.xz, .tar.zst)`, `${isFile ? stem(name) : name}.zip`);
                        if (archive) run(() => fileCompress([path], archive));
                    }}
                ><FileArchive size={16} aria-hidden /></button>
            )}
            {isFile && (
                <a href={`/api/files/download?path=${encodeURIComponent(path)}`} className="btn btn-ghost" title="Download" aria-label={`Download ${name}`}><Download size={16} aria-hidden /></a>
            )}
            <button
                type="button" className="btn btn-ghost" title="Rename" aria-label={`Rename ${name}`} disabled={pending}
                onClick={() => {
                    const next = window.prompt(`Rename ${name} to`, name);
                    if (next && next !== name) run(() => fileRename(path, next));
                }}
            ><Pencil size={16} aria-hidden /></button>
            <button
                type="button" className="btn btn-ghost btn-ghost-danger" title="Delete" aria-label={`Delete ${name}`} disabled={pending}
                onClick={() => {
                    if (window.confirm(`Delete ${name}${isFile ? "" : " and everything in it"}? This can't be undone.`)) run(() => fileRemove(path));
                }}
            ><Trash2 size={16} aria-hidden /></button>
        </>
    );
}
