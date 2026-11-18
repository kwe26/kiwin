import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Brand } from "@/components/brand";
import { KiwiAuth } from "@/lib/auth";
import { KiwiImg } from "@/lib/img";
import { currentUser } from "@/lib/session";
import { login } from "@/app/actions";

export const metadata: Metadata = { title: "Sign in" };

export default async function Login() {
    if (!KiwiImg.exists() || !KiwiAuth.hasMaster()) redirect("/");
    if (await currentUser()) redirect("/dashboard");
    return (
        <main className="auth">
            <div className="card auth-card">
                <Brand />
                <h1>Sign in</h1>
                <p className="lead">Use the master account.</p>
                <ActionForm action={login}>
                    <label>Username<input type="text" name="username" autoComplete="username" required autoFocus /></label>
                    <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
                    <SubmitButton>Sign in</SubmitButton>
                </ActionForm>
            </div>
        </main>
    );
}
