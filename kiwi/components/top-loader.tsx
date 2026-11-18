"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/** Background traffic that must not drive the bar (live views and polling). */
const IGNORE = /\/api\/(terminal|desktop|tasks|software|pm2\/logs)\b/;
/** Requests show the bar only if they take longer than this (clicks show it at once). */
const FETCH_DELAY_MS = 120;
/** Never leave the bar up longer than this, whatever happens. */
const MAX_MS = 30_000;

/**
 * Pace-style loading indicator: a bar across the top and a small spinner in
 * the corner while the panel waits on the server.
 *  - starts at once on a same-site link click or a form submit;
 *  - also counts the panel's own requests (navigations, Server Actions),
 *    minus prefetches and live polling;
 *  - finishes when the URL changes or the last request completes.
 */
function Loader() {
    const pathname = usePathname();
    const search = useSearchParams();
    const [progress, setProgress] = useState<number | null>(null);
    const state = useRef({ inflight: 0, nav: false });
    const timers = useRef<{ show?: ReturnType<typeof setTimeout>; trickle?: ReturnType<typeof setInterval>; hide?: ReturnType<typeof setTimeout>; max?: ReturnType<typeof setTimeout> }>({});

    const api = useRef({
        show() {
            const t = timers.current;
            clearTimeout(t.hide);
            clearTimeout(t.show);
            if (t.trickle) return; // already showing
            setProgress(10);
            t.trickle = setInterval(() => setProgress((p) => (p === null ? p : p + (92 - p) * 0.06)), 180);
            t.max = setTimeout(() => api.current.finish(true), MAX_MS);
        },
        finish(force = false) {
            const s = state.current;
            if (!force && (s.inflight > 0 || s.nav)) return;
            s.nav = false;
            if (force) s.inflight = 0;
            const t = timers.current;
            clearTimeout(t.show);
            clearTimeout(t.max);
            if (!t.trickle) return;
            clearInterval(t.trickle);
            t.trickle = undefined;
            setProgress(100);
            t.hide = setTimeout(() => setProgress(null), 350);
        },
    });

    // The URL changed: the navigation that was started has arrived.
    useEffect(() => {
        state.current.nav = false;
        api.current.finish();
    }, [pathname, search]);

    useEffect(() => {
        const { current: a } = api;
        const s = state.current;

        const onClick = (e: MouseEvent) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
            if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
            const url = new URL(link.href, location.href);
            if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
            if (url.pathname === location.pathname && url.search === location.search) return; // same page (or a #hash)
            s.nav = true;
            a.show();
        };
        const onSubmit = () => {
            s.nav = true;
            a.show();
            // A Server Action that doesn't navigate: its request finishing ends the bar.
            setTimeout(() => {
                s.nav = false;
                a.finish();
            }, 400);
        };
        document.addEventListener("click", onClick, true);
        document.addEventListener("submit", onSubmit, true);

        const original = window.fetch;
        const tracked = (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            if (IGNORE.test(url) || headers.has("next-router-prefetch")) return original(input, init);
            if (s.inflight++ === 0 && !timers.current.trickle) {
                clearTimeout(timers.current.show);
                timers.current.show = setTimeout(() => a.show(), FETCH_DELAY_MS);
            }
            return original(input, init).finally(() => {
                s.inflight = Math.max(0, s.inflight - 1);
                if (s.inflight === 0) clearTimeout(timers.current.show);
                a.finish();
            });
        };
        window.fetch = Object.assign(tracked, { preconnect: original.preconnect }) as typeof fetch;

        return () => {
            document.removeEventListener("click", onClick, true);
            document.removeEventListener("submit", onSubmit, true);
            window.fetch = original;
            const t = timers.current;
            clearTimeout(t.show);
            clearInterval(t.trickle);
            clearTimeout(t.hide);
            clearTimeout(t.max);
        };
    }, []);

    if (progress === null) return null;
    const leaving = progress >= 100;
    return (
        <div className={leaving ? "pace pace-done" : "pace"} role="progressbar" aria-label="Loading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
            <div className="pace-bar" style={{ width: `${progress}%` }}><span className="pace-peg" /></div>
            <div className="pace-spinner" aria-hidden />
        </div>
    );
}

export function TopLoader() {
    // useSearchParams needs a Suspense boundary.
    return <Suspense fallback={null}><Loader /></Suspense>;
}
