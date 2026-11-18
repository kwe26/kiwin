import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Brand } from "@/components/brand";
import { KiwiAuth } from "@/lib/auth";
import { KiwiImg } from "@/lib/img";
import { createMaster } from "@/app/actions";
import { setupCodeGiven } from "@/lib/session";

export const metadata: Metadata = { title: "Create master account" };

export default async function AccountSetup() {
    if (!KiwiImg.exists() || KiwiAuth.hasMaster()) redirect("/");
    const needCode = !(await setupCodeGiven());
    return (
        <main className="auth">
            <div className="card auth-card">
                <Brand />
                <h1>Create the master account</h1>
                <p className="lead">This account administers the server: sites, databases and services.</p>
                <ActionForm action={createMaster}>
                    {needCode && <label><span className="label-text">Setup code <span className="opt">(on the server: sudo kiwin setup-code)</span></span>
                        <input type="text" name="setupCode" required autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX" className="mono-input" />
                    </label>}
                    <label>Username<input type="text" name="username" autoComplete="username" required minLength={3} maxLength={32} /></label>
                    <label>Password<input type="password" name="password" autoComplete="new-password" required minLength={8} /></label>
                    <label>Confirm password<input type="password" name="confirm" autoComplete="new-password" required minLength={8} /></label>
                    <SubmitButton>Create account</SubmitButton>
                </ActionForm>
            </div>
        </main>
    );
}
