import type { Metadata } from "next";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { KiwiUpdates } from "@/lib/updates";
import { UpgradeButton } from "@/components/upgrade-button";
import { checkUpdates } from "@/app/actions";

export const metadata: Metadata = { title: "Updates" };

export default async function Updates() {
    const u = await KiwiUpdates.info();
    const r = u.latest;
    return (
        <>
            <div className="page-head">
                <h1>Updates</h1>
                <form action={checkUpdates}>
                    <button type="submit" className="btn btn-secondary"><RefreshCw size={15} aria-hidden /> Check now</button>
                </form>
            </div>
            {u.last && !u.last.ok && (
                <p className="notice notice-error" role="alert">
                    The last upgrade failed on {new Date(u.last.at).toUTCString()} and Kiwin went back to the previous version. The log is at state/upgrade.log on the host.
                </p>
            )}
            {u.error && <p className="notice notice-error" role="alert">{u.error}</p>}
            <div className="grid grid-split">
                <section className="card">
                    <h2>Installed</h2>
                    <div className="stack" style={{ gap: 6 }}>
                        <div className="item-sub">Version {u.current}</div>
                        {u.checkedAt && <div className="item-sub">Last checked {new Date(u.checkedAt).toUTCString()}</div>}
                    </div>
                </section>
                <section className="card">
                    <h2>Latest release</h2>
                    {r ? (
                        <div className="stack">
                            <div className="row">
                                <a href={r.pageUrl} target="_blank" rel="noreferrer">{r.version}</a>
                                <span className="hint">{r.name}</span>
                                {r.prerelease && <span className="chip">Pre-release</span>}
                            </div>
                            <div className="item-sub">Published {new Date(r.publishedAt).toUTCString()} · {Math.round(r.size / 1024 ** 2)} MB</div>
                            {r.notes && <pre className="item-sub" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{r.notes}</pre>}
                            {u.available
                                ? <UpgradeButton name={r.name} />
                                : <p className="hint"><ArrowUpCircle size={14} aria-hidden /> You are on the latest version.</p>}
                        </div>
                    ) : <p className="hint">No release found.</p>}
                </section>
            </div>
        </>
    );
}
