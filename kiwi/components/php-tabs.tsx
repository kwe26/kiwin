import Link from "next/link";

/** PHP version switcher, shown only when more than one version is installed. */
export function PhpVersionTabs({ versions, active, base }: { versions: string[]; active: string; base: string }) {
    if (versions.length < 2) return null;
    return (
        <div className="sw-tabs" role="tablist" style={{ marginBottom: 16 }}>
            {versions.map((v) => (
                <Link key={v} href={`${base}?v=${v}`} role="tab" aria-selected={v === active} className={v === active ? "active" : ""} style={{ padding: "6px 16px" }}>PHP {v}</Link>
            ))}
        </div>
    );
}
