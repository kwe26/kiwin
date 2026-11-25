"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Maximize, Minimize, Plug, RefreshCw, Scaling } from "lucide-react";
import { BridgeChannel } from "@/components/desktop-channel";

/**
 * A machine's screen: noVNC over the console bridge (see
 * app/api/vms/[name]/console). Same transport and styling as the Desktop page;
 * a guest sets its own resolution, so this one scales instead of resizing it.
 *
 * noVNC is served from public/novnc and loaded as a native ES module at
 * runtime: it uses top-level await, which bundlers can't handle.
 */
const NOVNC: string = "/novnc/core/rfb.js";

type Status = "connecting" | "connected" | "disconnected" | "error";

export function VmConsole({ name, running }: { name: string; running: boolean }) {
    const screen = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLDivElement>(null);
    const rfbRef = useRef<any>(null);
    const [status, setStatus] = useState<Status>(running ? "connecting" : "disconnected");
    const [message, setMessage] = useState<string | null>(running ? null : "The machine is not running.");
    const [generation, setGeneration] = useState(running ? 1 : 0);
    const [fullscreen, setFullscreen] = useState(false);
    const [scale, setScale] = useState(true);

    const reconnect = useCallback(() => setGeneration((g) => g + 1), []);

    useEffect(() => {
        if (!generation) return;
        let disposed = false;
        let rfb: any = null;
        setStatus("connecting");
        setMessage(null);
        (async () => {
            const base = `/api/vms/${encodeURIComponent(name)}/console`;
            const [{ default: RFB }, res] = await Promise.all([
                import(/* webpackIgnore: true */ /* turbopackIgnore: true */ NOVNC),
                fetch(base, { method: "POST" }),
            ]);
            const data = await res.json().catch(() => ({}));
            if (disposed) {
                if (data.id) fetch(`${base}/${data.id}`, { method: "DELETE" }).catch(() => {});
                return;
            }
            if (!res.ok) {
                setStatus("error");
                setMessage(data.error ?? `Could not open the console (HTTP ${res.status})`);
                return;
            }
            rfb = new RFB(canvas.current!, new BridgeChannel(data.id, base), { shared: true });
            rfbRef.current = rfb;
            rfb.background = "#141012";
            rfb.focusOnClick = true;
            rfb.qualityLevel = 6;
            rfb.compressionLevel = 2;
            // The guest owns its resolution: never ask it to match the window.
            rfb.resizeSession = false;
            rfb.scaleViewport = scale;
            rfb.clipViewport = !scale;
            rfb.addEventListener("connect", () => {
                setStatus("connected");
                rfb.focus();
            });
            rfb.addEventListener("disconnect", (e: CustomEvent<{ clean: boolean }>) => {
                if (disposed) return;
                setStatus("disconnected");
                setMessage(e.detail?.clean ? "Disconnected from the console." : "The connection to the console was lost.");
            });
        })().catch((e) => {
            if (disposed) return;
            setStatus("error");
            setMessage((e as Error).message);
        });
        return () => {
            disposed = true;
            rfbRef.current = null;
            try {
                rfb?.disconnect();
            } catch {}
        };
        // scale is applied live below; reconnecting isn't needed for it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [generation, name]);

    useEffect(() => {
        const rfb = rfbRef.current;
        if (!rfb) return;
        rfb.scaleViewport = scale;
        rfb.clipViewport = !scale;
    }, [scale]);

    useEffect(() => {
        const onChange = () => setFullscreen(document.fullscreenElement === screen.current);
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);

    const toggleFullscreen = () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else screen.current?.requestFullscreen({ navigationUI: "hide" }).then(() => rfbRef.current?.focus()).catch(() => {});
    };

    const label: Record<Status, string> = { connecting: "Connecting…", connected: "Connected", disconnected: "Not connected", error: "Not available" };

    return (
        <div className="desktop-wrap">
            <div className="desktop-bar">
                <span className="status">
                    <span className={status === "connected" ? "dot dot-ok" : status === "connecting" ? "dot" : "dot dot-bad"} aria-hidden />
                    {label[status]}
                </span>
                <div className="row">
                    <button type="button" className={scale ? "btn btn-secondary active" : "btn btn-ghost"} onClick={() => setScale((s) => !s)} title="Fit the machine's screen to the window, or show it pixel for pixel">
                        <Scaling size={15} aria-hidden /> {scale ? "Scaled" : "1:1"}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => rfbRef.current?.sendCtrlAltDel()} disabled={status !== "connected"} title="Send Ctrl+Alt+Del to the machine (the browser keeps its own)">
                        <Keyboard size={15} aria-hidden /> Ctrl+Alt+Del
                    </button>
                    {status === "connected" ? (
                        <button type="button" className="btn btn-ghost" onClick={() => rfbRef.current?.disconnect()}><Plug size={15} aria-hidden /> Disconnect</button>
                    ) : (
                        <button type="button" className="btn btn-ghost" onClick={reconnect}><RefreshCw size={15} aria-hidden /> Connect</button>
                    )}
                    <button type="button" className="btn btn-primary" onClick={toggleFullscreen} disabled={status !== "connected"}>
                        {fullscreen ? <Minimize size={15} aria-hidden /> : <Maximize size={15} aria-hidden />} Full screen
                    </button>
                </div>
            </div>
            <div ref={screen} className="desktop-screen">
                <div ref={canvas} className="desktop-canvas" key={generation} />
                {status !== "connected" && (
                    <div className="desktop-overlay">
                        <div>
                            <p>{status === "connecting" ? "Opening the console…" : message}</p>
                            {status !== "connecting" && (
                                <button type="button" className="btn btn-primary" onClick={reconnect}><RefreshCw size={15} aria-hidden /> Connect</button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
