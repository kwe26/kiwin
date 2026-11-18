import type { Metadata } from "next";
import Link from "next/link";
import { File, FileSymlink, Folder, HardDrive, House, Server, Share2 } from "lucide-react";
import { FileActions, FileToolbar } from "@/components/files";
import { HOME, KiwiFiles, clean, type Entry } from "@/lib/files";
import { KiwiArchive } from "@/lib/archive";
import { KiwiSoftware } from "@/lib/software";
import { OpenInCodeServer } from "@/components/open-in-code-server";
import { formatBytes } from "@/lib/services";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Files" };

const ROOTS = [
    { path: "/www", label: "Storage", icon: HardDrive },
    { path: "/mount/www", label: "Host /www", icon: Share2 },
    { path: "/", label: "System", icon: Server },
];

const TEXT_LIMIT = 2 * 1024 * 1024;

function EntryIcon({ e }: { e: Entry }) {
    if (e.type === "dir") return <Folder size={17} aria-hidden className="icon-folder" />;
    if (e.type === "link") return <FileSymlink size={17} aria-hidden />;
    return <File size={17} aria-hidden />;
}

export default async function Files({ searchParams }: { searchParams: Promise<{ path?: string }> }) {
    await requireUser();
    const dir = clean((await searchParams).path ?? HOME);
    const parts = dir.split("/").filter(Boolean);
    let entries: Entry[] = [];
    let error: string | null = null;
    if (!KiwiFiles.isDir(dir)) error = "This folder doesn't exist or isn't a folder.";
    else {
        try {
            entries = KiwiFiles.list(dir);
        } catch (e) {
            error = (e as Error).message;
        }
    }
    const href = (p: string) => `/files?path=${encodeURIComponent(p)}`;
    const archiver = KiwiArchive.available();
    const codeServer = error ? null : await KiwiSoftware.codeServerPort();

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Files</h1>
                    <nav className="crumbs" aria-label="Path">
                        <Link href={href("/")}><House size={14} aria-hidden /><span className="sr-only">Root</span></Link>
                        {parts.map((p, i) => (
                            <span key={i}>
                                <span aria-hidden>/</span>
                                <Link href={href("/" + parts.slice(0, i + 1).join("/"))} aria-current={i === parts.length - 1 ? "page" : undefined}>{p}</Link>
                            </span>
                        ))}
                    </nav>
                </div>
                <div className="row">
                    {codeServer && <OpenInCodeServer port={codeServer} folder={dir} />}
                    {ROOTS.map(({ path, label, icon: Icon }) => (
                        <Link key={path} href={href(path)} className={dir === path ? "btn btn-secondary active" : "btn btn-ghost"}>
                            <Icon size={15} aria-hidden /> {label}
                        </Link>
                    ))}
                </div>
            </div>

            <section className="card table-card">
                <div className="table-toolbar">
                    <FileToolbar dir={dir} />
                    {!archiver && <p className="hint" style={{ marginTop: 8 }}>Install <Link href="/software/7zip">7-Zip</Link> to extract and compress archives here.</p>}
                </div>
                {error ? <p className="notice notice-error" style={{ margin: 16 }}>{error}</p> : (
                    <div className="table-wrap">
                        <table className="table table-files">
                            <thead>
                                <tr>
                                    <th scope="col">Name</th>
                                    <th scope="col" className="num">Size</th>
                                    <th scope="col">Modified</th>
                                    <th scope="col">Permissions</th>
                                    <th scope="col"><span className="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {dir !== "/" && (
                                    <tr>
                                        <td colSpan={5}>
                                            <Link href={href(dir.split("/").slice(0, -1).join("/") || "/")} className="file-name"><Folder size={17} aria-hidden className="icon-folder" /> ..</Link>
                                        </td>
                                    </tr>
                                )}
                                {entries.length === 0 && <tr><td colSpan={5} className="empty">This folder is empty.</td></tr>}
                                {entries.map((e) => (
                                    <tr key={e.name}>
                                        <td>
                                            {e.type === "dir" ? (
                                                <Link href={href(e.path)} className="file-name"><EntryIcon e={e} /> {e.name}</Link>
                                            ) : (
                                                <span className="file-name"><EntryIcon e={e} /> {e.name}{e.target && <small> → {e.target}</small>}</span>
                                            )}
                                        </td>
                                        <td className="num">{e.type === "dir" ? "-" : formatBytes(e.size)}</td>
                                        <td>{new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ")}</td>
                                        <td><code>{e.mode}</code></td>
                                        <td className="cell-actions">
                                            <FileActions path={e.path} name={e.name} isFile={e.type === "file"} editable={e.type === "file" && e.size <= TEXT_LIMIT} archiver={archiver && e.type !== "other"} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </>
    );
}
