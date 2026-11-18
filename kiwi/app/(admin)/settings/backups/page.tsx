import type { Metadata } from "next";
import { Archive, Download, Trash2 } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { BackupUpload, RestoreDialog } from "@/components/backups";
import { JobLog } from "@/components/job-log";
import { KiwiBackups, PARTS, PART_IDS, BACKUP_DIR } from "@/lib/backups";
import { KiwiJobs } from "@/lib/jobs";
import { formatBytes } from "@/lib/services";
import { requireUser } from "@/lib/session";
import { createBackup, deleteBackup } from "@/app/actions";

export const metadata: Metadata = { title: "Backups & Restore" };

type Props = { searchParams: Promise<{ job?: string }> };

export default async function Backups({ searchParams }: Props) {
    await requireUser();
    const { job: jobId } = await searchParams;
    const linked = jobId ? KiwiJobs.get(jobId) : null;
    const job = linked?.key === "backup" ? linked : KiwiJobs.running("backup");
    const backups = KiwiBackups.list();
    const parts = PART_IDS.map((id) => ({ id, label: PARTS[id].label, about: PARTS[id].about }));
    const busy = !!job && !job.done;

    return (
        <>
            <div className="page-head"><h1>Backups &amp; Restore</h1></div>
            {job && (
                <section className="card" style={{ marginBottom: 16 }}>
                    <JobLog id={job.id} />
                </section>
            )}
            <div className="grid grid-split">
                <section className="card">
                    <h2>Create a backup</h2>
                    <p className="hint">Saved in {BACKUP_DIR} on user storage. Download it to keep a copy off this server.</p>
                    <ActionForm action={createBackup} className="stack">
                        <div className="ssl-box">
                            {parts.map((p) => (
                                <label key={p.id} className="check">
                                    <input type="checkbox" name="part" value={p.id} defaultChecked />
                                    <span>{p.label} <span className="opt">· {p.about}</span></span>
                                </label>
                            ))}
                        </div>
                        <div><SubmitButton><Archive size={15} aria-hidden /> {busy ? "A backup or restore is running" : "Back up now"}</SubmitButton></div>
                    </ActionForm>
                </section>
                <section className="card">
                    <h2>Restore from a file</h2>
                    <p className="hint">Upload a backup made by Kiwin, here or on another server, then restore it from the list. From another server, import its key first (<code>kiwin secret-key import</code> on the host) so stored passwords can be read.</p>
                    <BackupUpload />
                </section>
            </div>

            <section className="card" style={{ marginTop: 16 }}>
                <h2>Backups</h2>
                {backups.length === 0 ? <p className="hint">No backups yet.</p> : (
                    <div className="table-wrap">
                        <table className="table">
                            <thead><tr><th>File</th><th>Created</th><th>Size</th><th>Contains</th><th aria-label="Actions" /></tr></thead>
                            <tbody>
                                {backups.map((b) => (
                                    <tr key={b.name}>
                                        <td><code>{b.name}</code></td>
                                        <td>{new Date(b.createdAt).toUTCString()}</td>
                                        <td>{formatBytes(b.size)}</td>
                                        <td>{b.parts ? b.parts.map((p) => PARTS[p]?.label ?? p).join(", ") : "-"}</td>
                                        <td>
                                            <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                                                <a className="btn btn-ghost" title="Download" aria-label={`Download ${b.name}`} href={`/api/files/download?path=${encodeURIComponent(`${BACKUP_DIR}/${b.name}`)}`}><Download size={15} aria-hidden /></a>
                                                <RestoreDialog name={b.name} parts={parts.filter((p) => !b.parts || b.parts.includes(p.id))} />
                                                <ActionForm action={deleteBackup.bind(null, b.name)} className="inline-form">
                                                    <SubmitButton variant="ghost" confirm={`Delete ${b.name}? This can't be undone.`}><Trash2 size={15} aria-label="Delete" /></SubmitButton>
                                                </ActionForm>
                                            </div>
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
