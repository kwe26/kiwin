import { randomBytes } from "node:crypto";
import type { Subprocess } from "bun";

// Web terminal sessions: a login shell on a real PTY (Bun.Terminal) inside the
// isolation. The browser reads output over an event stream and posts input;
// see app/api/terminal.

const MAX_SESSIONS = 8;
const IDLE_MS = 10 * 60 * 1000;      // no viewer attached for this long -> close
const EXITED_MS = 60 * 1000;          // keep an exited shell this long so its viewer sees the end
const KILL_MS = 3 * 1000;             // SIGHUP, then SIGKILL if the shell is still there
const BACKLOG_BYTES = 256 * 1024;     // replayed when a viewer (re)attaches

export interface TerminalInfo {
    id: string;
    /** "Shell 3": numbers count up for the lifetime of the kiwi process. */
    title: string;
    createdAt: number;
    exited: boolean;
    viewers: number;
}

interface Session {
    id: string;
    title: string;
    createdAt: number;
    proc: Subprocess;
    backlog: Uint8Array[];
    backlogBytes: number;
    listeners: Set<(chunk: Uint8Array | null) => void>;
    lastSeen: number;
    exitCode: number | null;
}

// Next.js may load this module more than once; keep one store and one sweeper.
const g = globalThis as any;
const store = (g.__kiwiTerminals ??= new Map<string, Session>()) as Map<string, Session>;
g.__kiwiTerminalSeq ??= 0;

const SHELL_ENV = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    HOME: "/root",
    USER: "root",
    LOGNAME: "root",
    SHELL: "/bin/bash",
    // Same as kiwin's SANDBOX_PATH: /www/softwares/bin is where the Software page links commands.
    PATH: "/usr/local/sbin:/usr/local/bin:/www/softwares/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};

function sweep() {
    const now = Date.now();
    for (const s of store.values()) {
        const exitedLongAgo = s.exitCode !== null && now - s.lastSeen > EXITED_MS;
        const abandoned = s.listeners.size === 0 && now - s.lastSeen > IDLE_MS;
        if (exitedLongAgo || abandoned) KiwiTerminal.close(s.id);
    }
}
g.__kiwiTerminalSweeper ??= setInterval(sweep, 30_000);
(g.__kiwiTerminalSweeper as { unref?: () => void }).unref?.();

export class KiwiTerminal {
    static create(cols: number, rows: number): string {
        sweep();
        if (store.size >= MAX_SESSIONS) throw new Error(`Too many open terminals (max ${MAX_SESSIONS}); close one first`);
        const id = randomBytes(16).toString("hex");
        const session: Session = {
            id, title: `Shell ${++g.__kiwiTerminalSeq}`, createdAt: Date.now(),
            proc: null as any, backlog: [], backlogBytes: 0, listeners: new Set(), lastSeen: Date.now(), exitCode: null,
        };

        session.proc = Bun.spawn(["/bin/bash", "-l"], {
            cwd: "/www",
            env: SHELL_ENV,
            terminal: {
                cols: clamp(cols, 20, 500),
                rows: clamp(rows, 5, 200),
                data(_t: unknown, data: Uint8Array) {
                    const chunk = new Uint8Array(data);
                    session.backlog.push(chunk);
                    session.backlogBytes += chunk.length;
                    while (session.backlogBytes > BACKLOG_BYTES && session.backlog.length > 1) {
                        session.backlogBytes -= session.backlog.shift()!.length;
                    }
                    for (const l of session.listeners) l(chunk);
                },
            },
        } as any);
        session.proc.exited.then((code) => {
            session.exitCode = code;
            session.lastSeen = Date.now();
            for (const l of session.listeners) l(null);
        });
        store.set(id, session);
        return id;
    }

    /** Open sessions, oldest first. */
    static list(): TerminalInfo[] {
        sweep();
        return [...store.values()]
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, exited: s.exitCode !== null, viewers: s.listeners.size }));
    }

    static exists(id: string): boolean {
        return store.has(id);
    }

    /** Replays the backlog, then streams output; `null` means the shell exited. */
    static attach(id: string, listener: (chunk: Uint8Array | null) => void): () => void {
        const s = store.get(id);
        if (!s) throw new Error("No such terminal");
        for (const chunk of s.backlog) listener(chunk);
        if (s.exitCode !== null) {
            listener(null);
            return () => {};
        }
        s.listeners.add(listener);
        s.lastSeen = Date.now();
        return () => {
            s.listeners.delete(listener);
            s.lastSeen = Date.now();
        };
    }

    static write(id: string, data: string) {
        const s = store.get(id);
        if (!s || s.exitCode !== null) throw new Error("Terminal is closed");
        s.lastSeen = Date.now();
        (s.proc as any).terminal.write(data);
    }

    static resize(id: string, cols: number, rows: number) {
        const s = store.get(id);
        if (!s || s.exitCode !== null) return;
        (s.proc as any).terminal.resize(clamp(cols, 20, 500), clamp(rows, 5, 200));
    }

    static close(id: string) {
        const s = store.get(id);
        if (!s) return;
        store.delete(id);
        if (s.exitCode === null) {
            // bash passes SIGHUP on to its jobs; anything that ignores it gets killed.
            s.proc.kill("SIGHUP");
            setTimeout(() => s.exitCode === null && s.proc.kill("SIGKILL"), KILL_MS).unref?.();
        }
        try {
            (s.proc as any).terminal?.close?.();
        } catch {}
        for (const l of s.listeners) l(null);
    }
}

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, Math.floor(Number(n) || min)));
}
