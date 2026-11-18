import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PhpExtensionCatalog } from "@/components/php-extensions";
import { PhpVersionTabs } from "@/components/php-tabs";
import { KiwiPhp, type PhpExtensionPackage, type Sapi } from "@/lib/php";
import { requireUser } from "@/lib/session";
import { phpSetModule } from "@/app/actions";

export const metadata: Metadata = { title: "PHP extensions" };

function Toggle({ version, mod, sapi, on }: { version: string; mod: string; sapi: Sapi; on: boolean }) {
    return (
        <ActionForm action={phpSetModule.bind(null, version, mod, sapi, !on)} className="inline-form">
            <SubmitButton variant={on ? "secondary" : "ghost"}>{on ? "On" : "Off"}</SubmitButton>
        </ActionForm>
    );
}

export default async function PhpExtensions({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
    await requireUser();
    const versions = KiwiPhp.versions();
    const asked = (await searchParams).v;
    const v = asked && versions.includes(asked) ? asked : KiwiPhp.userVersion() ?? versions[0];
    if (!v) {
        return (
            <>
                <div className="page-head"><h1>PHP extensions</h1></div>
                <p className="hint">PHP is not installed. <Link href="/software/php">Install it from Software</Link>.</p>
            </>
        );
    }
    const user = KiwiPhp.isUser(v);
    const modules = user ? KiwiPhp.modules(v) : [];
    let catalog: PhpExtensionPackage[] = [];
    let catalogError: string | null = null;
    if (user) {
        try {
            catalog = await KiwiPhp.extensionPackages(v);
        } catch (e) {
            catalogError = (e as Error).message;
        }
    }

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>PHP {v} extensions</h1>
                    <p>{user ? `${modules.filter((m) => m.fpm).length} of ${modules.length} modules enabled for websites` : "Managed in the system image"}</p>
                </div>
                <Link href={`/php?v=${v}`} className="btn btn-secondary">Settings</Link>
            </div>

            <PhpVersionTabs versions={versions} active={v} base="/php/extensions" />

            {!user ? (
                <section className="card">
                    <p className="hint">PHP {v} comes from the system image. Install PHP from <Link href="/software/php">Software</Link> to manage extensions here.</p>
                </section>
            ) : (
                <div className="grid fw-grid">
                    <section className="card table-card">
                        <div className="table-toolbar"><h2>Modules</h2></div>
                        <div className="table-wrap">
                            <table className="table">
                                <thead>
                                    <tr>
                                        <th scope="col">Module</th>
                                        <th scope="col">Websites (FPM)</th>
                                        <th scope="col">Command line</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {modules.map((m) => (
                                        <tr key={m.name}>
                                            <td><strong>{m.name}</strong> <span className="hint">priority {m.priority}</span></td>
                                            <td><Toggle version={v} mod={m.name} sapi="fpm" on={m.fpm} /></td>
                                            <td><Toggle version={v} mod={m.name} sapi="cli" on={m.cli} /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                    <section className="card">
                        <h2>Install extensions</h2>
                        <p className="hint">From Ubuntu and Ondřej Surý&apos;s PHP repository, unpacked next to this PHP version with any libraries they need, then enabled. PHP-FPM reloads on its own.</p>
                        {catalogError ? <p className="notice notice-error">Could not load the package list: {catalogError}</p> : <PhpExtensionCatalog version={v} packages={catalog} />}
                    </section>
                </div>
            )}
        </>
    );
}
