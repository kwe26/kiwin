"use client";

import { useRef, useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { enterUpgrade } from "@/app/actions";
import { waitForRecovery } from "@/components/recovery-button";

/** Warns that the system shuts down, then hands over to the upgrade page on /recovery. */
export function UpgradeButton({ name }: { name: string }) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [phase, setPhase] = useState<"idle" | "stopping">("idle");
    const [error, setError] = useState<string | null>(null);

    async function upgrade() {
        setError(null);
        setPhase("stopping");
        const res = await enterUpgrade().catch((e: Error) => ({ error: e.message }));
        if ("error" in res) {
            setPhase("idle");
            setError(res.error);
            return;
        }
        if (await waitForRecovery()) window.location.href = `/recovery?t=${res.token}`;
        else {
            setPhase("idle");
            setError("The upgrade page did not come up. Try opening /recovery.");
        }
    }

    return (
        <>
            <button type="button" className="btn btn-primary" onClick={() => dialog.current?.showModal()}>
                <ArrowUpCircle size={15} aria-hidden /> Upgrade
            </button>
            <dialog ref={dialog} className="dialog" aria-label="Upgrade Kiwin">
                <div className="dialog-body">
                    <div className="dialog-head">
                        <h2>Upgrade to {name}?</h2>
                        <button type="button" className="btn btn-ghost" disabled={phase !== "idle"} onClick={() => dialog.current?.close()} aria-label="Close"><X size={16} aria-hidden /></button>
                    </div>
                    <p className="notice notice-error">
                        The system will shut down to upgrade. Your websites, databases, mail and everything else running here stop until the upgrade is finished.
                    </p>
                    <p className="hint">You continue on the recovery page, already signed in, where you start the upgrade. Your data and settings are kept.</p>
                    {error && <p className="notice notice-error" role="alert">{error}</p>}
                    <div className="row dialog-actions">
                        <button type="button" className="btn btn-ghost" disabled={phase !== "idle"} onClick={() => dialog.current?.close()}>Cancel</button>
                        <button type="button" className="btn btn-primary" disabled={phase !== "idle"} onClick={upgrade}>
                            {phase === "stopping" ? "Shutting down…" : "Shut down and continue"}
                        </button>
                    </div>
                </div>
            </dialog>
        </>
    );
}
