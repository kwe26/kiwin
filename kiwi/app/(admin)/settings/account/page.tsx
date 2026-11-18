import type { Metadata } from "next";
import { ActionForm, SubmitButton } from "@/components/forms";
import { KiwiAuth } from "@/lib/auth";
import { KiwiImg } from "@/lib/img";
import { formatBytes } from "@/lib/services";
import { requireUser } from "@/lib/session";
import { changePassword } from "@/app/actions";
import { RecoveryButton } from "@/components/recovery-button";

export const metadata: Metadata = { title: "Account" };

export default async function Account() {
    const user = await requireUser();
    const [master, img] = await Promise.all([KiwiAuth.master(), KiwiImg.info()]);

    return (
        <>
            <div className="page-head"><h1>Account</h1></div>
            <div className="grid grid-split">
                <section className="card">
                    <h2>{user}</h2>
                    <p className="hint">Master account</p>
                    <div className="stack" style={{ gap: 6 }}>
                        <div className="item-sub">Created {master?.createdAt ? new Date(master.createdAt).toUTCString() : "-"}</div>
                        <div className="item-sub">Storage volume {formatBytes(img?.sizeBytes ?? null)}{img?.mounted ? ", mounted" : ""}</div>
                        <div className="item-sub">On the host, <code>./kiwin get &lt;name&gt;</code> reads stored secrets.</div>
                    </div>
                </section>
                <section className="card">
                    <h2>System Recovery</h2>
                    <p className="hint">Stops only this panel and opens Kiwin System Recovery in its place. Websites, databases and mail keep running. Signing in there takes the server's root password.</p>
                    <RecoveryButton />
                </section>
                <section className="card">
                    <h2>Change password</h2>
                    <p className="hint">Other signed-in sessions are signed out.</p>
                    <ActionForm action={changePassword} className="stack" resetOnSuccess>
                        <label>Current password<input type="password" name="current" autoComplete="current-password" required /></label>
                        <label>New password<input type="password" name="password" autoComplete="new-password" required minLength={8} /></label>
                        <label>Confirm new password<input type="password" name="confirm" autoComplete="new-password" required minLength={8} /></label>
                        <SubmitButton>Change password</SubmitButton>
                    </ActionForm>
                </section>
            </div>
        </>
    );
}
