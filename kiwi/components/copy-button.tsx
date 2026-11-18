"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** Small button that copies `text` (e.g. a DNS record value). */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
    const [done, setDone] = useState(false);
    return (
        <button
            type="button"
            className="btn btn-ghost"
            title={label}
            aria-label={label}
            onClick={() => navigator.clipboard?.writeText(text).then(() => {
                setDone(true);
                setTimeout(() => setDone(false), 1500);
            }, () => {})}
        >
            {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </button>
    );
}
