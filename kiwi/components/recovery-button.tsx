"use client";

import { useRef, useState } from "react";
import { LifeBuoy, X } from "lucide-react";
import { openRecovery } from "@/app/actions";

/** Recovery has taken over the port once /recovery/ping answers with JSON. */
export async function waitForRecovery() {
    for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
            const res = await fetch("/recovery/ping", { cache: "no-store" });
            const data = res.ok ? await res.json().catch(() => null) : null;
            if (data?.recovery) return true;
        } catch {} // the panel is gone and recovery isn't up yet
    }
    return false;
}

/** Stops the panel (not the system) and moves to /recovery. */
export function RecoveryButton() {
    const dialog = useRef<HTMLDialogElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function open() {
        setError(null);
        setBusy(true);
        const res = await openRecovery().catch((e: Error) => ({ error: e.message }));
        if ("error" in res) {
            setBusy(false);
            setError(res.error);
            return;
        }
        if (await waitForRecovery()) window.location.href = "/recovery";
        else {
            setBusy(false);
            setError("Recovery did not come up. Try reloading the page.");
        }
    }

    return (
        <>
            <button type="button" className="btn btn-secondary" onClick={() => dialog.current?.showModal()}>
                <LifeBuoy size={15} aria-hidden /> Open Recovery
            </button>
            <dialog ref={dialog} className="dialog" aria-label="Open Recovery">
                <div className="dialog-body">
                    <div className="dialog-head">
                        <h2>Open Recovery?</h2>
                        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => dialog.current?.close()} aria-label="Close"><X size={16} aria-hidden /></button>
                    </div>
                    <p className="hint">This panel stops and Kiwin System Recovery takes its place. The system keeps running in the background. Choose Continue to Normal Interface there to come back.</p>
                    {error && <p className="notice notice-error" role="alert">{error}</p>}
                    <div className="row dialog-actions">
                        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
                        <button type="button" className="btn btn-primary" disabled={busy} onClick={open}>{busy ? "Stopping the panel…" : "Open Recovery"}</button>
                    </div>
                </div>
            </dialog>
        </>
    );
}
