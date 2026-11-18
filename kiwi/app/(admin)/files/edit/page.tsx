import type { Metadata } from "next";
import Link from "next/link";
import { posix } from "node:path";
import { Download } from "lucide-react";
import { CodeEditor } from "@/components/code-editor";
import { OpenInCodeServer } from "@/components/open-in-code-server";
import { KiwiSoftware } from "@/lib/software";
import { KiwiFiles, clean } from "@/lib/files";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Edit file" };

export default async function EditFile({ searchParams }: { searchParams: Promise<{ path?: string }> }) {
    await requireUser();
    const path = clean((await searchParams).path ?? "");
    const dir = posix.dirname(path);
    const file = KiwiFiles.readText(path);
    const codeServer = await KiwiSoftware.codeServerPort();
    return (
        <>
            <div className="page-head">
                <div>
                    <p><Link href={`/files?path=${encodeURIComponent(dir)}`}>← {dir}</Link></p>
                    <h1>{posix.basename(path)}</h1>
                    <p><code>{path}</code></p>
                </div>
                <div className="row">
                    {codeServer && <OpenInCodeServer port={codeServer} folder={dir} label="Open folder in Code Server" />}
                    <a href={`/api/files/download?path=${encodeURIComponent(path)}`} className="btn btn-secondary"><Download size={16} aria-hidden /> Download</a>
                </div>
            </div>
            <section className="card">
                {"content" in file ? <CodeEditor path={path} initial={file.content} /> : <p className="notice notice-error">{file.error}</p>}
            </section>
        </>
    );
}
