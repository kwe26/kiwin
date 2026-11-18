"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, KeyRound, RefreshCw, X } from "lucide-react";
import { SubmitButton, type ActionState } from "@/components/forms";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

// By name: server components render this dialog, and components can't be passed to the client.
const ICONS = { key: KeyRound, refresh: RefreshCw };

/**
 * A button that opens a modal asking for the master password (plus any extra
 * `fields`), runs `action` and shows the secret it returns there. Closing the
 * dialog unmounts its form, so the secret leaves the page.
 */
export function MasterPasswordDialog({
    action, label, title, icon = "key", variant = "secondary", intro = "Enter your master password to continue.",
    fields, submitLabel = "Show password",
}: {
    action: Action;
    label: string;
    title: string;
    icon?: keyof typeof ICONS;
    variant?: "secondary" | "ghost";
    intro?: string;
    /** Extra inputs shown under the master password. */
    fields?: ReactNode;
    submitLabel?: string;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [open, setOpen] = useState(false);
    const Icon = ICONS[icon];

    useEffect(() => {
        if (open) dialog.current?.showModal();
        else dialog.current?.close();
    }, [open]);

    return (
        <>
            <button type="button" className={`btn btn-${variant}`} onClick={() => setOpen(true)}>
                <Icon size={15} aria-hidden /> {label}
            </button>
            <dialog
                ref={dialog}
                className="dialog"
                aria-label={title}
                onClose={() => setOpen(false)}
                onClick={(e) => e.target === e.currentTarget && setOpen(false)}
            >
                {open && (
                    <DialogForm action={action} title={title} intro={intro} fields={fields} submitLabel={submitLabel} onClose={() => setOpen(false)} />
                )}
            </dialog>
        </>
    );
}

function DialogForm({ action, title, intro, fields, submitLabel, onClose }: {
    action: Action;
    title: string;
    intro: string;
    fields?: ReactNode;
    submitLabel: string;
    onClose: () => void;
}) {
    const [state, formAction] = useActionState(action, {});
    const [copied, setCopied] = useState(false);

    return (
        <div className="dialog-body">
            <div className="dialog-head">
                <h2>{title}</h2>
                <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close"><X size={16} aria-hidden /></button>
            </div>
            {state.secret ? (
                <>
                    <p className="hint">{state.message}</p>
                    <pre className="secret">{state.secret}</pre>
                    <div className="row dialog-actions">
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => navigator.clipboard?.writeText(state.secret!).then(() => setCopied(true), () => {})}
                        >
                            {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />} {copied ? "Copied" : "Copy"}
                        </button>
                        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
                    </div>
                </>
            ) : (
                <form action={formAction} className="stack">
                    <p className="hint">{intro}</p>
                    <label>Master password
                        <input type="password" name="password" autoComplete="current-password" required autoFocus />
                    </label>
                    {fields}
                    {state.message && <p className="notice notice-error" role="alert">{state.message}</p>}
                    <div className="row dialog-actions">
                        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                        <SubmitButton>{submitLabel}</SubmitButton>
                    </div>
                </form>
            )}
        </div>
    );
}
