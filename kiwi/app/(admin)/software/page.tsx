import type { Metadata } from "next";
import { SoftwareGrid, type SoftwareTile } from "@/components/software-grid";
import { KiwiSoftware, REPO_FILE, SOFTWARE_DIR } from "@/lib/software";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Software" };

export default async function SoftwarePage() {
    await requireUser();
    let apps: SoftwareTile[] = [];
    let error: string | null = null;
    try {
        // Entries that need other software (desktop apps need X.org Interface) appear once it is installed.
        apps = KiwiSoftware.catalog().filter((s) => KiwiSoftware.missingNeeds(s).length === 0 || KiwiSoftware.current(s.id)).map((s) => ({
            id: s.id, name: s.name, summary: s.summary, icon: s.icon, category: s.category,
            installed: KiwiSoftware.current(s.id),
            section: s.section,
        }));
    } catch (e) {
        error = (e as Error).message;
    }

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Software</h1>
                    <p>Installs to <code>{SOFTWARE_DIR}</code> on your storage and adds commands to PATH. The system image is never touched.</p>
                </div>
            </div>
            {error ? <p className="notice notice-error" role="alert">{error}</p> : <SoftwareGrid apps={apps} />}
            <p className="hint" style={{ marginTop: 16 }}>Catalogue: <code>{REPO_FILE}</code></p>
        </>
    );
}
