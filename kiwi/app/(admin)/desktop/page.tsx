import type { Metadata } from "next";
import Link from "next/link";
import { Monitor } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { DesktopView } from "@/components/desktop";
import { DESKTOP_HOME, KiwiDesktop } from "@/lib/desktop";
import { requireUser } from "@/lib/session";
import { stopDesktop } from "@/app/actions";

export const metadata: Metadata = { title: "Desktop" };

export default async function DesktopPage() {
    await requireUser();
    if (!KiwiDesktop.isInstalled()) {
        return (
            <>
                <div className="page-head"><div><h1>Desktop</h1><p>A graphical desktop inside the system, right in the panel.</p></div></div>
                <section className="card empty-state">
                    <Monitor size={36} aria-hidden />
                    <h2>X.org Interface is not installed</h2>
                    <p>Install it from Software (about 25 MB): an X server with the Openbox window manager, a panel and a terminal.</p>
                    <Link href="/software/xorg" className="btn btn-primary">Open in Software</Link>
                </section>
            </>
        );
    }
    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Desktop</h1>
                    <p>Openbox on X.org, running as root inside the isolation. Right-click the background for the menu; files live in <code>{DESKTOP_HOME}</code>.</p>
                </div>
                <ActionForm action={stopDesktop} className="inline-form">
                    <SubmitButton variant="secondary" confirm="Stop the desktop? Open windows are closed.">Stop desktop</SubmitButton>
                </ActionForm>
            </div>
            <DesktopView />
        </>
    );
}
