"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Monitor, Package, Search } from "lucide-react";

export interface SoftwareTile {
    id: string;
    name: string;
    summary: string;
    icon: string;
    category?: string;
    installed: string | null;
    section?: "desktop";
}

export function SoftwareIcon({ src, name, size }: { src: string; name: string; size: number }) {
    const [broken, setBroken] = useState(false);
    if (!src || broken) {
        return <span className="app-icon app-icon-fallback" style={{ width: size, height: size }}><Package size={size * 0.5} aria-hidden /></span>;
    }
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="app-icon" src={src} alt={`${name} icon`} width={size} height={size} onError={() => setBroken(true)} referrerPolicy="no-referrer" />;
}

function Tiles({ apps }: { apps: SoftwareTile[] }) {
    if (apps.length === 0) return null;
    return (
        <div className="sw-grid">
            {apps.map((a) => (
                <Link key={a.id} href={`/software/${a.id}`} className="sw-tile">
                    <SoftwareIcon src={a.icon} name={a.name} size={56} />
                    <span className="sw-tile-text">
                        <strong>{a.name}</strong>
                        <small>{a.summary}</small>
                    </span>
                    {a.installed && <span className="pill pill-ok sw-tile-badge"><Check size={12} aria-hidden /> {a.installed}</span>}
                </Link>
            ))}
        </div>
    );
}

/** GNOME Software-style catalogue: Explore / Installed tabs, search, app tiles; desktop apps in their own section. */
export function SoftwareGrid({ apps }: { apps: SoftwareTile[] }) {
    const [tab, setTab] = useState<"explore" | "installed">("explore");
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const shown = apps.filter((a) =>
        (tab === "explore" || a.installed) &&
        (!q || a.name.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q) || a.category?.toLowerCase().includes(q)));
    const installedCount = apps.filter((a) => a.installed).length;

    return (
        <div className="stack" style={{ gap: 20 }}>
            <div className="sw-toolbar">
                <div className="sw-tabs" role="tablist">
                    <button type="button" role="tab" aria-selected={tab === "explore"} className={tab === "explore" ? "active" : ""} onClick={() => setTab("explore")}>Explore</button>
                    <button type="button" role="tab" aria-selected={tab === "installed"} className={tab === "installed" ? "active" : ""} onClick={() => setTab("installed")}>
                        Installed{installedCount > 0 && <span className="sw-count">{installedCount}</span>}
                    </button>
                </div>
                <label className="sw-search">
                    <Search size={16} aria-hidden />
                    <span className="sr-only">Search software</span>
                    <input type="search" placeholder="Search software" value={query} onChange={(e) => setQuery(e.target.value)} />
                </label>
            </div>

            {shown.length === 0 ? (
                <section className="card empty-state">
                    <Package size={36} aria-hidden />
                    <h2>{tab === "installed" && !q ? "Nothing installed yet" : "No matches"}</h2>
                    <p>{tab === "installed" && !q ? "Software you install appears here." : "Try another search."}</p>
                </section>
            ) : (
                <>
                    <Tiles apps={shown.filter((a) => a.section !== "desktop")} />
                    {shown.some((a) => a.section === "desktop") && (
                        <section className="stack" style={{ gap: 12 }}>
                            <div>
                                <h2 className="sw-section-title"><Monitor size={18} aria-hidden /> Desktop apps</h2>
                                <p className="hint">Graphical apps for the X.org desktop, opened from the Desktop page.</p>
                            </div>
                            <Tiles apps={shown.filter((a) => a.section === "desktop")} />
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
