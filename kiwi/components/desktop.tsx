"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardPaste, Maximize, Minimize, Plug, RefreshCw, Scaling } from "lucide-react";
import { BridgeChannel } from "@/components/desktop-channel";

/**
 * noVNC is served from public/novnc and loaded as a native ES module at
 * runtime: it uses top-level await, which bundlers can't handle.
 */
const NOVNC: string = "/novnc/core/rfb.js";

type Status = "connecting" | "connected" | "disconnected" | "error";

export function DesktopView() {
    const screen = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLDivElement>(null);
    const rfbRef = useRef<any>(null);
    const [status, setStatus] = useState<Status>("connecting");
    const [message, setMessage] = useState<string | null>(null);
    const [generation, setGeneration] = useState(0);
    const [fullscreen, setFullscreen] = useState(false);
    const [scale, setScale] = useState(false);
    const [clipOpen, setClipOpen] = useState(false);
    const [clip, setClip] = useState("");

    const reconnect = useCallback(() => setGeneration((g) => g + 1), []);

    useEffect(() => {
        let disposed = false;
        let rfb: any = null;
        setStatus("connecting");
        setMessage(null);
        (async () => {
            const [{ default: RFB }, res] = await Promise.all([
                import(/* webpackIgnore: true */ /* turbopackIgnore: true */ NOVNC),
                fetch("/api/desktop", { method: "POST" }),
            ]);
            const data = await res.json().catch(() => ({}));
            if (disposed) {
                if (data.id) fetch(`/api/desktop/${data.id}`, { method: "DELETE" }).catch(() => {});
                return;
            }
            if (!res.ok) {
                setStatus("error");
                setMessage(data.error ?? `Could not start the desktop (HTTP ${res.status})`);
                return;
            }
            rfb = new RFB(canvas.current!, new BridgeChannel(data.id), { shared: true });
            rfbRef.current = rfb;
            rfb.background = "#141012";
            rfb.focusOnClick = true;
            rfb.qualityLevel = 6;
            rfb.compressionLevel = 2;
            rfb.resizeSession = !scale;
            rfb.scaleViewport = scale;
            rfb.addEventListener("connect", () => {
                setStatus("connected");
                rfb.focus();
            });
            rfb.addEventListener("disconnect", (e: CustomEvent<{ clean: boolean }>) => {
                if (disposed) return;
                setStatus("disconnected");
                setMessage(e.detail?.clean ? "Disconnected from the desktop." : "The connection to the desktop was lost.");
            });
            rfb.addEventListener("clipboard", (e: CustomEvent<{ text: string }>) => setClip(e.detail.text));
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
    }, [generation]);

    useEffect(() => {
        const rfb = rfbRef.current;
        if (!rfb) return;
        rfb.scaleViewport = scale;
        rfb.resizeSession = !scale;
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

    const label: Record<Status, string> = { connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected", error: "Not available" };

    return (
        <div className="desktop-wrap">
            <div className="desktop-bar">
                <span className="status">
                    <span className={status === "connected" ? "dot dot-ok" : status === "connecting" ? "dot" : "dot dot-bad"} aria-hidden />
                    {label[status]}
                </span>
                <div className="row">
                    <button type="button" className={scale ? "btn btn-secondary active" : "btn btn-ghost"} onClick={() => setScale((s) => !s)} title="Scale the desktop to the window instead of resizing it">
                        <Scaling size={15} aria-hidden /> {scale ? "Scaled" : "Fit by resizing"}
                    </button>
                    <button type="button" className={clipOpen ? "btn btn-secondary active" : "btn btn-ghost"} onClick={() => setClipOpen((o) => !o)}>
                        <ClipboardPaste size={15} aria-hidden /> Clipboard
                    </button>
                    {status === "connected" ? (
                        <button type="button" className="btn btn-ghost" onClick={() => rfbRef.current?.disconnect()}><Plug size={15} aria-hidden /> Disconnect</button>
                    ) : (
                        <button type="button" className="btn btn-ghost" onClick={reconnect}><RefreshCw size={15} aria-hidden /> Reconnect</button>
                    )}
                    <button type="button" className="btn btn-primary" onClick={toggleFullscreen} disabled={status !== "connected"}>
                        {fullscreen ? <Minimize size={15} aria-hidden /> : <Maximize size={15} aria-hidden />} Full screen
                    </button>
                </div>
            </div>
            {clipOpen && (
                <div className="desktop-clip stack" style={{ gap: 6 }}>
                    <textarea
                        value={clip}
                        onChange={(e) => {
                            setClip(e.target.value);
                            rfbRef.current?.clipboardPasteFrom(e.target.value);
                        }}
                        placeholder="Text copied in the desktop shows up here. Type or paste here to send it to the desktop's clipboard."
                        aria-label="Desktop clipboard"
                    />
                </div>
            )}
            <div ref={screen} className="desktop-screen">
                <div ref={canvas} className="desktop-canvas" key={generation} />
                {status !== "connected" && (
                    <div className="desktop-overlay">
                        <div>
                            <p>{status === "connecting" ? "Starting the desktop…" : message}</p>
                            {status !== "connecting" && (
                                <button type="button" className="btn btn-primary" onClick={reconnect}><RefreshCw size={15} aria-hidden /> Reconnect</button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
