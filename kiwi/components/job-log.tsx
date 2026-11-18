"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

interface JobState {
    title: string;
    lines: string[];
    done: boolean;
    ok: boolean;
}

/** Follows a background job's log; refreshes the page when it finishes. */
export function JobLog({ id, okMessage, failHint }: { id: string; okMessage?: string; failHint?: string }) {
    const router = useRouter();
    const [job, setJob] = useState<JobState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const pre = useRef<HTMLPreElement>(null);

    useEffect(() => {
        let stop = false;
        const poll = async () => {
            try {
                const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
                const data = await res.json();
                if (stop) return;
                if (!res.ok) return setError(data.error ?? "Task not found");
                setJob(data);
                if (data.done) return router.refresh();
            } catch {
                if (stop) return;
            }
            setTimeout(() => !stop && poll(), 1000);
        };
        poll();
        return () => {
            stop = true;
        };
    }, [id, router]);

    useEffect(() => {
        const el = pre.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [job]);

    if (error) return <p className="notice notice-error">{error}</p>;
    if (!job) return <p className="hint"><Loader2 size={14} className="spin" aria-hidden /> Loading…</p>;
    return (
        <div className="stack" style={{ gap: 8 }}>
            <p className="row" role="status" style={{ margin: 0, fontWeight: 600 }}>
                {!job.done ? <Loader2 size={16} className="spin" aria-hidden /> : job.ok ? <CheckCircle2 size={16} color="var(--ok)" aria-hidden /> : <XCircle size={16} color="var(--accent)" aria-hidden />}
                {job.title}{!job.done ? "…" : job.ok ? ": done" : ": failed"}
            </p>
            <pre ref={pre} className="log job-log">{job.lines.join("\n") || "Starting…"}</pre>
            {job.done && job.ok && okMessage && <p className="notice notice-ok">{okMessage}</p>}
            {job.done && !job.ok && failHint && <p className="hint">{failHint}</p>}
        </div>
    );
}
