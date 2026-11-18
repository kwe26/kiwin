"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { confirmFirewall, revertFirewall } from "@/app/actions";

/** "Keep these firewall settings?" with a countdown to the daemon's automatic rollback. */
export function FirewallPending({ revertAt }: { revertAt: number }) {
    const router = useRouter();
    const [left, setLeft] = useState(() => Math.max(0, Math.round((revertAt - Date.now()) / 1000)));

    useEffect(() => {
        const t = setInterval(() => {
            const s = Math.max(0, Math.round((revertAt - Date.now()) / 1000));
            setLeft(s);
            if (s === 0) {
                clearInterval(t);
                setTimeout(() => router.refresh(), 1500);
            }
        }, 1000);
        return () => clearInterval(t);
    }, [revertAt, router]);

    return (
        <div className="fw-pending" role="alert">
            <ShieldAlert size={20} aria-hidden />
            <div>
                <strong>Keep these firewall settings?</strong>
                <p>They close ports that were open. If you can still use the panel, keep them; otherwise they are undone in <b>{left}s</b>.</p>
            </div>
            <div className="row">
                <form action={revertFirewall}><button type="submit" className="btn btn-secondary">Undo</button></form>
                <form action={confirmFirewall}><button type="submit" className="btn btn-primary">Keep changes</button></form>
            </div>
        </div>
    );
}
