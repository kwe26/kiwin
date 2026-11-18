import { ActionForm, SubmitButton } from "@/components/forms";
import { KiwiMysql } from "@/lib/mysql";
import { setupMysql } from "@/app/actions";

/** The "install / set up MySQL" card, or null once MySQL is ready. */
export function MysqlGate({ title }: { title: string }) {
    if (KiwiMysql.isInstalled() && KiwiMysql.isSetup()) return null;
    const installed = KiwiMysql.isInstalled();
    return (
        <>
            <div className="page-head"><h1>{title}</h1></div>
            <section className="card" style={{ maxWidth: 560 }}>
                <h2>{installed ? "MySQL is not set up yet" : "MySQL is not installed"}</h2>
                <p className="hint">
                    {installed
                        ? "This creates a MySQL instance on your storage (/www/db) with a new random root password."
                        : "Install mysql-server in the system image, then come back here to set it up."}
                </p>
                {installed && (
                    <ActionForm action={setupMysql}><SubmitButton>Set up MySQL</SubmitButton></ActionForm>
                )}
            </section>
        </>
    );
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do {
        n /= 1024;
        i++;
    } while (n >= 1024 && i < units.length - 1);
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
