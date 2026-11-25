"use client";

import { useState } from "react";
import { FileCode, FileText, Lock, Network } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { createSite } from "@/app/actions";

type SiteType = "static" | "proxy" | "php";

export function CreateSiteForm({ phpVersions, email, staging }: { phpVersions: string[]; email: string; staging: boolean }) {
    const [type, setType] = useState<SiteType>("static");
    const [ssl, setSsl] = useState(false);
    const types: { id: SiteType; title: string; text: string; icon: typeof FileText; disabled?: string }[] = [
        { id: "static", title: "Static", text: "HTML, CSS, JS and assets served straight from disk.", icon: FileText },
        { id: "proxy", title: "Proxy", text: "Forward requests to an app, e.g. Node, Bun or a container.", icon: Network },
        {
            id: "php", title: "PHP", text: phpVersions.length ? `PHP-FPM ${phpVersions.join(", ")}` : "Install php-fpm in the system image to enable.",
            icon: FileCode, disabled: phpVersions.length ? undefined : "not installed",
        },
    ];

    return (
        <ActionForm action={createSite} className="stack create-form">
            <fieldset className="type-picker">
                <legend>Type</legend>
                {types.map(({ id, title, text, icon: Icon, disabled }) => (
                    <label key={id} className={disabled ? "type-option disabled" : "type-option"}>
                        <input type="radio" name="type" value={id} checked={type === id} disabled={!!disabled} onChange={() => setType(id)} />
                        <span className="type-card">
                            <Icon size={22} aria-hidden />
                            <strong>{title}{disabled && <em> · {disabled}</em>}</strong>
                            <small>{text}</small>
                        </span>
                    </label>
                ))}
            </fieldset>

            <div className="grid form-grid">
                <label>Domain<input type="text" name="domain" placeholder="example.com" required autoCapitalize="none" spellCheck={false} autoFocus /></label>
                <label><span className="label-text">Aliases <span className="opt">(optional, comma separated)</span></span><input type="text" name="aliases" placeholder="www.example.com" autoCapitalize="none" spellCheck={false} /></label>
                {type === "proxy" && (
                    <label>Proxy to<input type="text" name="proxy" placeholder="http://127.0.0.1:3000" required autoCapitalize="none" spellCheck={false} /></label>
                )}
                {type === "php" && (
                    <label>PHP version
                        <select name="php" defaultValue={phpVersions[0]}>
                            {phpVersions.map((v) => <option key={v} value={v}>PHP {v}</option>)}
                        </select>
                    </label>
                )}
            </div>

            <div className="ssl-box">
                <label className="check">
                    <input type="checkbox" name="ssl" checked={ssl} onChange={(e) => setSsl(e.target.checked)} />
                    <span><Lock size={15} aria-hidden /> Secure with Let&apos;s Encrypt{staging ? " (staging)" : ""}</span>
                </label>
                <p className="hint">The domain must already point to this server and port 80 must be reachable from the internet. You can also do this later from the website&apos;s page.</p>
                {ssl && (
                    <label><span className="label-text">Email for expiry notices <span className="opt">(optional)</span></span>
                        <input type="text" inputMode="email" name="email" defaultValue={email} placeholder="you@example.com" autoCapitalize="none" spellCheck={false} />
                    </label>
                )}
            </div>

            <p className="hint">New websites start with attack prevention on: one visitor can ask for 15 requests a second, known scanners are refused, and probes for <code>.env</code> or <code>.git</code> never reach the site. Change or switch it off on the website&apos;s page.</p>

            <div className="row"><SubmitButton>Create website</SubmitButton></div>
        </ActionForm>
    );
}
