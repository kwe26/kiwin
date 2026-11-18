import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Globe, Plus, Settings2 } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { HttpsBadge, TypeBadge, siteTarget } from "@/components/site-badges";
import { KiwiNginx } from "@/lib/nginx";
import { requireUser } from "@/lib/session";
import { reloadNginx, testNginx } from "@/app/actions";

export const metadata: Metadata = { title: "Websites" };

export default async function Websites() {
    await requireUser();
    const installed = KiwiNginx.isInstalled();
    const status = await KiwiNginx.status().catch(() => null);
    const sites = KiwiNginx.list();

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Websites</h1>
                    <p>
                        {!installed ? "nginx is not installed in the system image." : (
                            <>
                                <span className={status?.state === "running" ? "dot dot-ok" : "dot dot-bad"} aria-hidden /> nginx {status?.state ?? "unknown"}
                                {" · "}{sites.length} website{sites.length === 1 ? "" : "s"}
                            </>
                        )}
                    </p>
                </div>
                <div className="row">
                    <ActionForm action={testNginx} className="inline-form"><SubmitButton variant="secondary">Test config</SubmitButton></ActionForm>
                    <ActionForm action={reloadNginx} className="inline-form"><SubmitButton variant="secondary">Reload nginx</SubmitButton></ActionForm>
                    <Link href="/websites/new" className="btn btn-primary"><Plus size={16} aria-hidden /> Create website</Link>
                </div>
            </div>

            {sites.length === 0 ? (
                <section className="card empty-state">
                    <Globe size={36} aria-hidden />
                    <h2>No websites yet</h2>
                    <p>Create a static site, a reverse proxy to an app, or a PHP site.</p>
                    <Link href="/websites/new" className="btn btn-primary"><Plus size={16} aria-hidden /> Create website</Link>
                </section>
            ) : (
                <section className="card table-card">
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th scope="col">Website</th>
                                    <th scope="col">Type</th>
                                    <th scope="col">Serves</th>
                                    <th scope="col">HTTPS</th>
                                    <th scope="col">Status</th>
                                    <th scope="col"><span className="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {sites.map((site) => {
                                    const secured = KiwiNginx.hasCert(site);
                                    const url = `${secured ? "https" : "http"}://${site.domain}`;
                                    return (
                                        <tr key={site.domain}>
                                            <td>
                                                <Link href={`/websites/${site.domain}`} className="site-name">
                                                    <span className="site-icon"><Globe size={16} aria-hidden /></span>
                                                    <span>
                                                        <strong>{site.domain}</strong>
                                                        {site.aliases.length > 0 && <small>{site.aliases.join(", ")}</small>}
                                                    </span>
                                                </Link>
                                            </td>
                                            <td><TypeBadge site={site} /></td>
                                            <td><code className="truncate" title={siteTarget(site)}>{siteTarget(site)}</code></td>
                                            <td><HttpsBadge site={site} secured={secured} /></td>
                                            <td>
                                                <span className="status"><span className={site.enabled ? "dot dot-ok" : "dot"} aria-hidden />{site.enabled ? "Enabled" : "Disabled"}</span>
                                            </td>
                                            <td className="cell-actions">
                                                <a href={url} target="_blank" rel="noreferrer" className="btn btn-ghost" aria-label={`Visit ${site.domain}`}><ArrowUpRight size={16} aria-hidden /> Visit</a>
                                                <Link href={`/websites/${site.domain}`} className="btn btn-secondary"><Settings2 size={15} aria-hidden /> Manage</Link>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
        </>
    );
}
