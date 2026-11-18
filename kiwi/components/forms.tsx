"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

export interface ActionState {
    ok?: boolean;
    message?: string;
    /** Shown once in a copyable block (new database password, root password). */
    secret?: string;
}

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** A form bound to a server action, showing its result message under the fields. */
export function ActionForm({ action, children, className, resetOnSuccess = false }: {
    action: Action;
    children: ReactNode;
    className?: string;
    resetOnSuccess?: boolean;
}) {
    const [state, formAction] = useActionState(action, {});
    return (
        <form action={formAction} className={className} key={resetOnSuccess && state.ok ? state.message : undefined}>
            {children}
            {state.message && (
                <p className={state.ok ? "notice notice-ok" : "notice notice-error"} role={state.ok ? "status" : "alert"}>
                    {state.message}
                </p>
            )}
            {state.secret && <pre className="secret">{state.secret}</pre>}
        </form>
    );
}

export function SubmitButton({ children, variant = "primary", confirm }: {
    children: ReactNode;
    variant?: "primary" | "secondary" | "danger" | "ghost";
    /** Ask before submitting (destructive actions). */
    confirm?: string;
}) {
    const { pending } = useFormStatus();
    return (
        <button
            type="submit"
            className={`btn btn-${variant}`}
            disabled={pending}
            onClick={(e) => {
                if (confirm && !window.confirm(confirm)) e.preventDefault();
            }}
        >
            {pending ? "Working…" : children}
        </button>
    );
}
