import type { Metadata } from "next";
import { CreateDatabaseForm } from "@/components/create-database";
import { MysqlGate } from "@/components/mysql-gate";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Create database" };

export default async function NewDatabase() {
    await requireUser();
    const gate = MysqlGate({ title: "Create database" });
    if (gate) return gate;
    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Create database</h1>
                    <p>A MySQL database and a user with full access to it. The password is stored encrypted and can be shown again with your master password.</p>
                </div>
            </div>
            <section className="card" style={{ maxWidth: 720 }}>
                <CreateDatabaseForm />
            </section>
        </>
    );
}
