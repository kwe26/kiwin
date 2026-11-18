"use client";

import { useEffect, useState } from "react";
import { SquareCode } from "lucide-react";

/**
 * Opens a folder in code-server, which listens on its own port of this host
 * (plain HTTP). Rendered only while the code-server service runs.
 */
export function OpenInCodeServer({ port, folder, label = "Open in Code Server" }: { port: number; folder: string; label?: string }) {
    const [href, setHref] = useState<string | null>(null);
    // The host name the browser used for the panel; only known in the browser.
    useEffect(() => setHref(`http://${window.location.hostname}:${port}/?folder=${encodeURIComponent(folder)}`), [port, folder]);
    if (!href) return null;
    return (
        <a href={href} target="_blank" rel="noreferrer" className="btn btn-secondary" title={`code-server on port ${port}`}>
            <SquareCode size={15} aria-hidden /> {label}
        </a>
    );
}
