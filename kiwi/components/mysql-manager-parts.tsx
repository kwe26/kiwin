import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { setMysqlManager } from "@/app/mysql-actions";

/** Manager › database › table. */
export function Crumbs({ db, table }: { db?: string; table?: string }) {
    return (
        <p className="mm-crumbs">
            <Link href="/databases/manager">MySQL Manager</Link>
            {db && <> › <Link href={`/databases/manager/${encodeURIComponent(db)}`}>{db}</Link></>}
            {table && <> › <Link href={`/databases/manager/${encodeURIComponent(db!)}/${encodeURIComponent(table)}`}>{table}</Link></>}
        </p>
    );
}

/** Shown in place of every Manager page while it is off. */
export function ManagerOff() {
    return (
        <>
            <div className="page-head"><h1>MySQL Manager</h1></div>
            <section className="card" style={{ maxWidth: 620 }}>
                <h2>The MySQL Manager is off</h2>
                <p className="hint">Explore and edit every database like phpMyAdmin: browse and edit rows, change columns and indexes, run SQL. It works as MySQL&apos;s root user, so it stays off until you turn it on.</p>
                <ActionForm action={setMysqlManager.bind(null, true)} className="stack">
                    <label>Master password<input type="password" name="password" autoComplete="current-password" required /></label>
                    <div><SubmitButton>Turn on the MySQL Manager</SubmitButton></div>
                </ActionForm>
            </section>
        </>
    );
}

export function ManagerError({ message }: { message: string }) {
    return <p className="notice notice-error" role="alert">{message}</p>;
}

export const fmtBytes = (n: number | string | null | undefined) => {
    const b = Number(n ?? 0);
    if (!b) return "-";
    const u = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
