"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { phpInstallExtension } from "@/app/actions";
import type { PhpExtensionPackage } from "@/lib/php";

/** Searchable list of php<ver>-* extension packages, with Install buttons. */
export function PhpExtensionCatalog({ version, packages }: { version: string; packages: PhpExtensionPackage[] }) {
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const shown = packages.filter((p) => !q || p.module.includes(q) || p.description.toLowerCase().includes(q));

    return (
        <div className="stack">
            <label className="sw-search" style={{ width: "100%" }}>
                <Search size={16} aria-hidden />
                <span className="sr-only">Search extensions</span>
                <input type="search" placeholder="Search extensions (redis, gd, intl, imagick…)" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="list ext-list">
                {shown.length === 0 && <p className="empty">No matching extensions.</p>}
                {shown.map((p) => (
                    <div className="item" key={p.name}>
                        <div className="item-main">
                            <div className="item-title">{p.module} {p.installed && <span className="badge badge-ok">installed</span>}</div>
                            <div className="item-sub">{p.description} · <code>{p.name}</code></div>
                        </div>
                        {!p.installed && (
                            <div className="item-actions">
                                <ActionForm action={phpInstallExtension.bind(null, version, p.name)} className="inline-form">
                                    <SubmitButton variant="secondary">Install</SubmitButton>
                                </ActionForm>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
