import type { Metadata } from "next";
import Link from "next/link";
import { Database, Download, KeyRound, Plus, Table2 } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { MasterPasswordDialog } from "@/components/master-password";
import { MysqlGate, formatBytes } from "@/components/mysql-gate";
import { KiwiMysql } from "@/lib/mysql";
import { requireUser } from "@/lib/session";
import { KiwiMysqlAdmin } from "@/lib/mysql-admin";
import { setMysqlManager } from "@/app/mysql-actions";
import { changeDatabasePassword, dropDatabase, revealDatabasePassword, revealRootPassword } from "@/app/actions";

export const metadata: Metadata = { title: "Databases" };

export default async function Databases() {
    await requireUser();
    const gate = MysqlGate({ title: "Databases" });
    if (gate) return gate;

    const status = await KiwiMysql.status().catch(() => null);
    const dbs = status?.state === "running" ? await KiwiMysql.databaseInfo().catch(() => null) : null;

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Databases</h1>
                    <p>
                        <span className={status?.state === "running" ? "dot dot-ok" : "dot dot-bad"} aria-hidden /> MySQL {status?.state ?? "unknown"} on <code>127.0.0.1:3306</code>
                        {dbs && <>{" · "}{dbs.length} database{dbs.length === 1 ? "" : "s"}</>}
                    </p>
                </div>
                <div className="row">
                    {KiwiMysqlAdmin.enabled()
                        ? <Link href="/databases/manager" className="btn btn-secondary"><Table2 size={16} aria-hidden /> MySQL Manager</Link>
                        : <MasterPasswordDialog action={setMysqlManager.bind(null, true)} label="MySQL Manager" title="Turn on the MySQL Manager" icon="key"
                            intro="Browse and edit every database like phpMyAdmin. It works as MySQL's root user, so it is off until you turn it on." submitLabel="Turn on" />}
                    <MasterPasswordDialog action={revealRootPassword} label="Root password" title="MySQL root password" />
                    <Link href="/databases/new" className="btn btn-primary"><Plus size={16} aria-hidden /> Create database</Link>
                </div>
            </div>

            {dbs === null ? (
                <section className="card"><p className="empty">Could not reach MySQL. Check the mysql service.</p></section>
            ) : dbs.length === 0 ? (
                <section className="card empty-state">
                    <Database size={36} aria-hidden />
                    <h2>No databases yet</h2>
                    <p>Create a database with its own user, or import a .sql dump.</p>
                    <div className="row">
                        <Link href="/databases/new" className="btn btn-primary"><Plus size={16} aria-hidden /> Create database</Link>
                        <Link href="/databases/transfer" className="btn btn-secondary">Import</Link>
                    </div>
                </section>
            ) : (
                <section className="card table-card">
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th scope="col">Database</th>
                                    <th scope="col">Users</th>
                                    <th scope="col" className="num">Tables</th>
                                    <th scope="col" className="num">Size</th>
                                    <th scope="col"><span className="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {dbs.map((db) => (
                                    <tr key={db.name}>
                                        <td>
                                            <span className="site-name">
                                                <span className="site-icon"><Database size={16} aria-hidden /></span>
                                                <strong>{db.name}</strong>
                                            </span>
                                        </td>
                                        <td>
                                            {db.users.length === 0 ? <span className="hint">none</span> : (
                                                <div className="components">
                                                    {db.users.map((u) => (
                                                        <span key={u} className={u.split("@")[0] === db.savedUser ? "chip" : "chip chip-off"} title={u.split("@")[0] === db.savedUser ? "Password stored by kiwi" : undefined}>{u}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </td>
                                        <td className="num">{db.tables}</td>
                                        <td className="num">{formatBytes(db.sizeBytes)}</td>
                                        <td className="cell-actions">
                                            <div className="item-actions" style={{ justifyContent: "flex-end" }}>
                                                <MasterPasswordDialog
                                                    action={revealDatabasePassword.bind(null, db.name)}
                                                    label="Password"
                                                    title={`${db.name} credentials`}
                                                    variant="ghost"
                                                />
                                                <MasterPasswordDialog
                                                    action={changeDatabasePassword.bind(null, db.name)}
                                                    label="Change"
                                                    icon="refresh"
                                                    title={`Change password of ${db.savedUser ?? db.name}`}
                                                    variant="ghost"
                                                    intro={`Sets a new password for the ${db.savedUser ?? db.name} user (created if it is missing). Apps using the old password stop working.`}
                                                    submitLabel="Change password"
                                                    fields={
                                                        <label><span className="label-text">New password <span className="opt">(empty = generate)</span></span>
                                                            <input type="password" name="new_password" autoComplete="new-password" minLength={8} />
                                                        </label>
                                                    }
                                                />
                                                <a href={`/api/databases/export?db=${encodeURIComponent(db.name)}`} className="btn btn-ghost" download>
                                                    <Download size={15} aria-hidden /> Export
                                                </a>
                                                <ActionForm action={dropDatabase.bind(null, db.name)}>
                                                    <SubmitButton variant="danger" confirm={`Delete ${db.name}? All its tables and data, and its user, are permanently deleted.`}>Delete</SubmitButton>
                                                </ActionForm>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
            <p className="hint" style={{ marginTop: 12 }}>
                <KeyRound size={13} aria-hidden /> Passwords are stored encrypted with the host key; showing or changing one needs your master password.
            </p>
        </>
    );
}
