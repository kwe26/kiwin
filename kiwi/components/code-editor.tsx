"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { Save, WrapText } from "lucide-react";
import { fileSave } from "@/app/actions";

/** Fits CodeMirror to the panel's look (fonts, borders); colours come from the light or One Dark theme. */
const chrome = EditorView.theme({
    "&": { height: "100%", fontSize: "13.5px" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
    "&.cm-focused": { outline: "none" },
});

/**
 * Code editor for one file: syntax highlighting by file name, search (Ctrl+F),
 * Ctrl/Cmd+S to save. `onSave` replaces the plain file save (e.g. test and
 * reload nginx), returning an error message or null.
 */
export function CodeEditor({ path, initial, onSave, filename, saveLabel = "Save" }: {
    path: string;
    initial: string;
    onSave?: (content: string) => Promise<string | null>;
    /** Name used to pick the language, when `path` isn't a real file name. */
    filename?: string;
    saveLabel?: string;
}) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const saved = useRef(initial);
    const wrapSlot = useRef(new Compartment());
    const [dirty, setDirty] = useState(false);
    const [wrap, setWrap] = useState(false);
    const [language, setLanguage] = useState("Plain text");
    const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
    const [pending, start] = useTransition();
    const saveRef = useRef<() => void>(() => {});

    saveRef.current = () => start(async () => {
        const v = view.current;
        if (!v) return;
        const content = v.state.doc.toString();
        const err = onSave ? await onSave(content) : await fileSave(path, content);
        if (err) setStatus({ ok: false, text: err });
        else {
            saved.current = content;
            setDirty(false);
            setStatus({ ok: true, text: "Saved" });
        }
    });

    useEffect(() => {
        if (!host.current) return;
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        const languageSlot = new Compartment();
        const v = new EditorView({
            parent: host.current,
            state: EditorState.create({
                doc: initial,
                extensions: [
                    basicSetup,
                    keymap.of([
                        indentWithTab,
                        { key: "Mod-s", preventDefault: true, run: () => (saveRef.current(), true) },
                    ]),
                    languageSlot.of([]),
                    wrapSlot.current.of([]),
                    chrome,
                    ...(dark ? [oneDark] : []),
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged) setDirty(u.state.doc.toString() !== saved.current);
                    }),
                ],
            }),
        });
        view.current = v;
        // Language support loads on demand (one chunk per language).
        const name = filename ?? path.split("/").pop() ?? "";
        const desc = LanguageDescription.matchFilename(languages, name) ?? (filename?.endsWith(".conf") ? languages.find((l) => l.name === "Nginx") ?? null : null);
        if (desc) {
            desc.load().then((support) => {
                v.dispatch({ effects: languageSlot.reconfigure(support) });
                setLanguage(desc.name);
            }).catch(() => {});
        }
        v.focus();
        return () => {
            v.destroy();
            view.current = null;
        };
    }, [initial, path, filename]);

    useEffect(() => {
        view.current?.dispatch({ effects: wrapSlot.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
    }, [wrap]);

    // Don't lose edits to a stray click away.
    useEffect(() => {
        if (!dirty) return;
        const warn = (e: BeforeUnloadEvent) => e.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);

    return (
        <div className="stack code-editor-wrap">
            <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row">
                    <button type="button" className="btn btn-primary" onClick={() => saveRef.current()} disabled={pending || !dirty}>
                        <Save size={15} aria-hidden /> {pending ? "Saving…" : saveLabel}
                    </button>
                    <span className="hint">{dirty ? "Unsaved changes · Ctrl+S to save" : status?.text ?? "No changes"}</span>
                </div>
                <div className="row">
                    <span className="chip">{language}</span>
                    <button type="button" className={wrap ? "btn btn-secondary active" : "btn btn-ghost"} onClick={() => setWrap((w) => !w)} title="Wrap long lines">
                        <WrapText size={15} aria-hidden /> Wrap
                    </button>
                </div>
            </div>
            {status && !status.ok && <p className="notice notice-error" role="alert">{status.text}</p>}
            <div ref={host} className="code-editor" aria-label={`Contents of ${path}`} />
        </div>
    );
}
