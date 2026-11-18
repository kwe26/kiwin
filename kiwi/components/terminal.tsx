"use client";

import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";
import type { TerminalInfo } from "@/lib/terminal";

type Status = "connecting" | "connected" | "reconnecting" | "exited" | "error";
const STORAGE_KEY = "kiwi-terminal-id";

async function api(path: string, body?: unknown, method = "POST") {
    return fetch(path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const remember = (id: string | null) => {
    try {
        if (id) sessionStorage.setItem(STORAGE_KEY, id);
        else sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
};
const remembered = () => {
    try {
        return sessionStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
};

/**
 * Web terminal with one tab per shell session. Sessions live in kiwi (see
 * lib/terminal.ts), so they survive reloads and are shared by every browser
 * tab; this page lists them, attaches to one and can open or end them.
 */
export function TerminalView() {
    const host = useRef<HTMLDivElement>(null);
    const size = useRef({ cols: 80, rows: 24 });
    const [sessions, setSessions] = useState<TerminalInfo[] | null>(null);
    const [active, setActive] = useState<string | null>(null);
    const [status, setStatus] = useState<Status>("connecting");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const started = useRef(false);

    const select = useCallback((id: string | null) => {
        remember(id);
        setActive(id);
    }, []);

    const refresh = useCallback(async (): Promise<TerminalInfo[] | null> => {
        const res = await api("/api/terminal", undefined, "GET").catch(() => null);
        if (!res?.ok) return null;
        const list = ((await res.json()) as { sessions: TerminalInfo[] }).sessions;
        setSessions(list);
        return list;
    }, []);

    const create = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api("/api/terminal", size.current);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.error ?? `Could not open a terminal (HTTP ${res.status})`);
                return;
            }
            setSessions(data.sessions);
            select(data.id);
        } finally {
            setBusy(false);
        }
    }, [select]);

    const end = useCallback(async (id: string) => {
        await api(`/api/terminal/${id}`, undefined, "DELETE").catch(() => {});
        const list = (await refresh()) ?? [];
        if (id === active) {
            const next = list.find((s) => !s.exited) ?? list[0];
            select(next?.id ?? null);
        }
    }, [active, refresh, select]);

    // First load: reattach to this tab's last session, else the first open one, else start one.
    useEffect(() => {
        if (!started.current) (async () => {
            started.current = true;
            const list = await refresh();
            if (!list) {
                setStatus("error");
                setError("Could not load terminal sessions");
                return;
            }
            const last = remembered();
            const pick = list.find((s) => s.id === last) ?? list.find((s) => !s.exited);
            if (pick) select(pick.id);
            else await create();
        })();
        // Sessions opened or ended from another browser tab.
        const onFocus = () => void refresh();
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [refresh, select, create]);

    // Attach xterm to the active session.
    useEffect(() => {
        if (!active) return;
        const id = active;
        let disposed = false;
        let cleanup = () => {};
        setStatus("connecting");
        setError(null);

        (async () => {
            const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
            if (disposed || !host.current) return;
            const css = getComputedStyle(document.documentElement);
            const term = new Terminal({
                cursorBlink: true,
                fontFamily: css.getPropertyValue("--mono") || "monospace",
                fontSize: 14,
                scrollback: 5000,
                theme: { background: "#141012", foreground: "#f1e9e9", cursor: "#ef5350", cursorAccent: "#141012", selectionBackground: "#ef535055" },
            });
            const fit = new FitAddon();
            term.loadAddon(fit);
            term.open(host.current);
            const resize = () => {
                fit.fit();
                size.current = { cols: term.cols, rows: term.rows };
            };
            resize();
            term.focus();
            api(`/api/terminal/${id}`, { type: "resize", ...size.current }).catch(() => {});

            // Output: the stream replays the backlog on every (re)connect, so clear first.
            const events = new EventSource(`/api/terminal/${id}`);
            let opened = false;
            let exited = false;
            events.onopen = () => {
                if (opened) term.reset();
                opened = true;
                setStatus("connected");
            };
            events.onmessage = (e) => term.write(Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0)));
            events.addEventListener("exit", () => {
                exited = true;
                events.close();
                setStatus("exited");
                setSessions((list) => list?.map((s) => (s.id === id ? { ...s, exited: true } : s)) ?? list);
                term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
            });
            events.onerror = () => {
                if (exited) return;
                if (events.readyState === EventSource.CLOSED) {
                    // 404: the session is gone (ended elsewhere, or kiwi restarted).
                    setStatus("error");
                    void refresh();
                } else setStatus("reconnecting");
            };

            // Input: batch keystrokes briefly and send in order.
            let pending = "";
            let timer: ReturnType<typeof setTimeout> | undefined;
            let chain = Promise.resolve();
            const flush = () => {
                const data = pending;
                pending = "";
                chain = chain.then(() => api(`/api/terminal/${id}`, { type: "input", data }).then(() => {}, () => {}));
            };
            const input = term.onData((d) => {
                if (exited) return;
                pending += d;
                clearTimeout(timer);
                timer = setTimeout(flush, 5);
            });

            // Resize with the window/sidebar.
            let resizeTimer: ReturnType<typeof setTimeout> | undefined;
            const observer = new ResizeObserver(() => {
                resize();
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => api(`/api/terminal/${id}`, { type: "resize", ...size.current }).catch(() => {}), 120);
            });
            observer.observe(host.current);

            cleanup = () => {
                observer.disconnect();
                input.dispose();
                events.close();
                clearTimeout(timer);
                clearTimeout(resizeTimer);
                term.dispose();
            };
        })().catch((e) => {
            setStatus("error");
            setError((e as Error).message);
        });

        return () => {
            disposed = true;
            cleanup();
        };
    }, [active, refresh]);

    const label: Record<Status, string> = {
        connecting: "Connecting…",
        connected: "Connected",
        reconnecting: "Reconnecting…",
        exited: "Session ended",
        error: "Disconnected",
    };
    const current = sessions?.find((s) => s.id === active);

    return (
        <div className="terminal-wrap">
            <div className="terminal-bar">
                <div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">
                    {sessions?.map((s) => (
                        <div key={s.id} className={s.id === active ? "terminal-tab active" : "terminal-tab"}>
                            <button type="button" role="tab" aria-selected={s.id === active} onClick={() => select(s.id)} title={`Opened ${new Date(s.createdAt).toLocaleTimeString()}`}>
                                <span className={s.exited ? "dot dot-bad" : s.id === active && status === "connected" ? "dot dot-ok" : "dot"} aria-hidden />
                                {s.title}
                            </button>
                            <button type="button" className="terminal-tab-close" onClick={() => end(s.id)} aria-label={`End ${s.title}`} title="End session">
                                <X size={13} aria-hidden />
                            </button>
                        </div>
                    ))}
                    <button type="button" className="btn btn-ghost" onClick={create} disabled={busy} title="New session">
                        <Plus size={15} aria-hidden /> New
                    </button>
                </div>
                {current && (
                    <span className="status">
                        <span className={status === "connected" ? "dot dot-ok" : status === "exited" || status === "error" ? "dot dot-bad" : "dot"} aria-hidden />
                        {label[status]}
                    </span>
                )}
            </div>
            {error && <p className="notice notice-error" role="alert">{error}</p>}
            {active ? (
                <div ref={host} key={active} className="terminal" />
            ) : (
                sessions && (
                    <div className="terminal terminal-empty">
                        <SquareTerminal size={28} aria-hidden />
                        <p>No open sessions.</p>
                        <button type="button" className="btn btn-primary" onClick={create} disabled={busy}><Plus size={15} aria-hidden /> New session</button>
                    </div>
                )
            )}
        </div>
    );
}
