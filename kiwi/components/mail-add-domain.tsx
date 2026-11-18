"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";

interface Step {
    text: string;
    state: "running" | "done" | "warn" | "failed";
}

/** Add-domain form that shows the Mail Server setting itself up, step by step. */
export function MailAddDomain() {
    const router = useRouter();
    const [domain, setDomain] = useState("");
    const [steps, setSteps] = useState<Step[]>([]);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setSteps([]);
        setResult(null);
        // Each new step finishes the one before it.
        const push = (text: string, state: Step["state"] = "running") =>
            setSteps((s) => [...s.map((x) => (x.state === "running" ? { ...x, state: "done" as const } : x)), { text, state }]);
        try {
            const res = await fetch("/api/mail/domains", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain }) });
            if (!res.body) throw new Error(`HTTP ${res.status}`);
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buf = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += value;
                let i;
                while ((i = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, i);
                    buf = buf.slice(i + 1);
                    if (!line.trim()) continue;
                    const msg = JSON.parse(line) as { step?: string; level?: string; done?: boolean; error?: string };
                    if (msg.step) push(msg.step, msg.level === "warn" ? "warn" : "running");
                    if (msg.done) {
                        setSteps((s) => s.map((x) => (x.state === "running" ? { ...x, state: "done" } : x)));
                        setResult({ ok: true, text: `${domain} is ready. Set the DNS records below, then check them.` });
                        setDomain("");
                        router.refresh();
                    }
                    if (msg.error) {
                        setSteps((s) => s.map((x) => (x.state === "running" ? { ...x, state: "failed" } : x)));
                        setResult({ ok: false, text: msg.error });
                        router.refresh();
                    }
                }
            }
        } catch (err) {
            setResult({ ok: false, text: (err as Error).message });
        } finally {
            setBusy(false);
        }
    };

    const icon = (s: Step["state"]) =>
        s === "running" ? <LoaderCircle size={15} className="spin" aria-hidden />
            : s === "done" ? <Check size={15} className="ok" aria-hidden />
                : s === "warn" ? <CircleAlert size={15} className="warn" aria-hidden />
                    : <X size={15} className="bad" aria-hidden />;

    return (
        <form onSubmit={submit} className="stack">
            <div className="fw-add-row">
                <label>Domain
                    <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" required autoCapitalize="none" spellCheck={false} disabled={busy} />
                </label>
            </div>
            <div className="row"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Setting up…" : "Add domain"}</button></div>
            {steps.length > 0 && (
                <ol className="steps" aria-live="polite">
                    {steps.map((s, i) => <li key={i} className={`step step-${s.state}`}>{icon(s.state)} {s.text}</li>)}
                </ol>
            )}
            {result && <p className={result.ok ? "notice notice-ok" : "notice notice-error"} role={result.ok ? "status" : "alert"}>{result.text}</p>}
        </form>
    );
}
