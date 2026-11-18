import type { Metadata } from "next";
import Link from "next/link";
import { FileCode, Puzzle } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PhpVersionTabs } from "@/components/php-tabs";
import { KiwiPhp, SETTINGS, type Sapi } from "@/lib/php";
import { requireUser } from "@/lib/session";
import { phpReload, phpSaveSettings, serviceAction } from "@/app/actions";

export const metadata: Metadata = { title: "PHP" };

const STATE_BADGE: Record<string, string> = { running: "badge badge-ok", failed: "badge badge-bad", backoff: "badge badge-warn" };

export default async function PhpPage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
    await requireUser();
    const versions = KiwiPhp.versions();
    if (versions.length === 0) {
        return (
            <>
                <div className="page-head"><h1>PHP</h1></div>
                <section className="card empty-state">
                    <FileCode size={36} aria-hidden />
                    <h2>PHP is not installed</h2>
                    <p>Install PHP from Software to run PHP websites.</p>
                    <Link href="/software/php" className="btn btn-primary">Install PHP</Link>
                </section>
            </>
        );
    }
    const asked = (await searchParams).v;
    const v = asked && versions.includes(asked) ? asked : KiwiPhp.userVersion() ?? versions[0];
    const user = KiwiPhp.isUser(v);
    const status = await KiwiPhp.status(v);
    const settings = user ? KiwiPhp.settings(v) : {};
    const effective = KiwiPhp.effective(v, SETTINGS.map((s) => s.key));
    const files: { label: string; path: string }[] = user
        ? [
            ...(["fpm", "cli"] as Sapi[]).map((sapi) => ({ label: `php.ini (${sapi === "fpm" ? "websites, PHP-FPM" : "command line"})`, path: KiwiPhp.conf(v, sapi, "php.ini") })),
            { label: "FPM pool (www.conf)", path: KiwiPhp.conf(v, "fpm", "pool.d", "www.conf") },
            { label: "FPM global (php-fpm.conf)", path: KiwiPhp.conf(v, "fpm", "php-fpm.conf") },
        ]
        : [];

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>PHP {v}</h1>
                    <p>
                        <span className={STATE_BADGE[status?.state ?? ""] ?? "badge"}>PHP-FPM {status?.state ?? "not set up"}</span>
                        {" "}{KiwiPhp.version(v) ?? ""} · socket <code>{KiwiPhp.socket(v)}</code>
                    </p>
                </div>
                <div className="row">
                    {status?.state === "running" ? (
                        <ActionForm action={phpReload.bind(null, v)} className="inline-form"><SubmitButton variant="secondary">Test and reload</SubmitButton></ActionForm>
                    ) : status ? (
                        <ActionForm action={serviceAction.bind(null, KiwiPhp.unitName(v), "start")} className="inline-form"><SubmitButton>Start PHP-FPM</SubmitButton></ActionForm>
                    ) : null}
                    <Link href={`/php/extensions?v=${v}`} className="btn btn-primary"><Puzzle size={16} aria-hidden /> Extensions</Link>
                </div>
            </div>

            <PhpVersionTabs versions={versions} active={v} base="/php" />

            {!user ? (
                <section className="card">
                    <p className="hint">
                        PHP {v} comes from the system image; its configuration is in <code>/etc/php/{v}</code>, which the panel leaves alone.
                        Install PHP from <Link href="/software/php">Software</Link> to manage settings and extensions here.
                    </p>
                </section>
            ) : (
                <div className="grid sw-body">
                    <section className="card">
                        <h2>Settings</h2>
                        <p className="hint">Applied to websites and the command line, in <code>conf.d/99-kiwi.ini</code>. Empty = PHP&apos;s default.</p>
                        <ActionForm action={phpSaveSettings.bind(null, v)} className="stack">
                            <div className="php-settings">
                                {SETTINGS.map((s) => (
                                    <label key={s.key}>
                                        <span className="label-text">{s.label} <span className="opt">{effective[s.key] !== undefined ? `now ${effective[s.key] || "empty"}` : ""}</span></span>
                                        {s.key === "display_errors" ? (
                                            <select name={s.key} defaultValue={settings[s.key] ?? ""}>
                                                <option value="">Default</option>
                                                <option value="Off">Off</option>
                                                <option value="On">On</option>
                                            </select>
                                        ) : (
                                            <input type="text" name={s.key} defaultValue={settings[s.key] ?? ""} placeholder={s.hint} autoCapitalize="none" spellCheck={false} />
                                        )}
                                    </label>
                                ))}
                            </div>
                            <div className="row"><SubmitButton>Save and reload</SubmitButton></div>
                        </ActionForm>
                    </section>
                    <section className="card">
                        <h2>Configuration files</h2>
                        <p className="hint">Edit them directly, then use Test and reload.</p>
                        <div className="list">
                            {files.map((f) => (
                                <div className="item" key={f.path}>
                                    <div className="item-main">
                                        <div className="item-title">{f.label}</div>
                                        <div className="item-sub"><code>{f.path}</code></div>
                                    </div>
                                    <div className="item-actions">
                                        <Link href={`/files/edit?path=${encodeURIComponent(f.path)}`} className="btn btn-ghost">Edit</Link>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
            )}
        </>
    );
}
