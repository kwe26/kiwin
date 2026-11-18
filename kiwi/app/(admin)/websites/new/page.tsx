import type { Metadata } from "next";
import Link from "next/link";
import { CreateSiteForm } from "@/components/create-site";
import { KiwiAcme } from "@/lib/acme";
import { KiwiNginx } from "@/lib/nginx";
import { KiwiPhp } from "@/lib/php";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Create website" };

export default async function NewWebsite() {
    await requireUser();
    return (
        <>
            <div className="page-head">
                <div>
                    <p><Link href="/websites">← Websites</Link></p>
                    <h1>Create website</h1>
                </div>
            </div>
            <section className="card" style={{ maxWidth: 880 }}>
                {KiwiNginx.isInstalled()
                    ? <CreateSiteForm phpVersions={KiwiPhp.versions()} email={KiwiAcme.email()} staging={KiwiAcme.isStaging()} />
                    : <p className="notice notice-error">nginx is not installed in the system image.</p>}
            </section>
        </>
    );
}
