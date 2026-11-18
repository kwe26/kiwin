import { FileCode, FileText, Lock, LockOpen, Network } from "lucide-react";
import type { Site } from "@/lib/nginx";

export function TypeBadge({ site }: { site: Site }) {
    if (site.type === "proxy") return <span className="badge"><Network size={13} aria-hidden /> Proxy</span>;
    if (site.type === "php") return <span className="badge"><FileCode size={13} aria-hidden /> PHP {site.php}</span>;
    return <span className="badge"><FileText size={13} aria-hidden /> Static</span>;
}

export function HttpsBadge({ site, secured }: { site: Site; secured: boolean }) {
    if (!secured || !site.ssl) return <span className="badge"><LockOpen size={13} aria-hidden /> HTTP only</span>;
    const days = Math.floor((new Date(site.ssl.expiresAt).getTime() - Date.now()) / 86_400_000);
    const cls = days < 0 ? "badge badge-bad" : days < 14 ? "badge badge-warn" : "badge badge-ok";
    const when = days < 0 ? "Expired" : days === 0 ? "Expires today" : `${days} day${days === 1 ? "" : "s"} left`;
    return (
        <span className={cls} title={`Valid until ${new Date(site.ssl.expiresAt).toUTCString()}${site.ssl.staging ? " (staging certificate)" : ""}`}>
            <Lock size={13} aria-hidden /> {site.ssl.staging ? "Staging · " : ""}{when}
        </span>
    );
}

export function siteTarget(site: Site): string {
    return site.type === "proxy" ? site.proxy! : `/www/sites/${site.domain}/public_html`;
}
