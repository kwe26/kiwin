import { accessSync, constants } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ServerWebSocket, Subprocess } from "bun";

// Host root shells for recovery's Manage Terminal: real PTYs shown with xterm.
// They live until closed or until recovery closes, so a reload reattaches.

const MAX_SHELLS = 6;
const BACKLOG_BYTES = 256 * 1024;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n) || lo));

export interface ShellSocket {
  shell: string;
}

interface Shell {
  id: string;
  title: string;
  createdAt: number;
  proc: Subprocess;
  backlog: Uint8Array[];
  bytes: number;
  sockets: Set<ServerWebSocket<ShellSocket>>;
  exitCode: number | null;
}

export class HostShells {
  private shells = new Map<string, Shell>();
  private seq = 0;

  list() {
    return [...this.shells.values()].map((s) => ({ id: s.id, title: s.title, exited: s.exitCode !== null }));
  }

  has(id: string) {
    return this.shells.has(id);
  }

  create(cols = 100, rows = 30): string {
    if (this.shells.size >= MAX_SHELLS) throw new Error(`At most ${MAX_SHELLS} shells; close one first`);
    let home = "/root";
    try {
      accessSync(home, constants.X_OK);
    } catch {
      home = "/";
    }
    const shell: Shell = {
      id: randomBytes(12).toString("hex"), title: `Shell ${++this.seq}`, createdAt: Date.now(),
      proc: null as unknown as Subprocess, backlog: [], bytes: 0, sockets: new Set(), exitCode: null,
    };
    shell.proc = Bun.spawn(["/bin/bash", "-l"], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/root", USER: "root", LOGNAME: "root", SHELL: "/bin/bash",
        TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG ?? "C.UTF-8",
      },
      terminal: {
        cols: clamp(cols, 20, 500),
        rows: clamp(rows, 5, 200),
        data: (_t: unknown, data: Uint8Array) => {
          const chunk = new Uint8Array(data);
          shell.backlog.push(chunk);
          shell.bytes += chunk.length;
          while (shell.bytes > BACKLOG_BYTES && shell.backlog.length > 1) shell.bytes -= shell.backlog.shift()!.length;
          for (const ws of shell.sockets) ws.sendBinary(chunk);
        },
      },
    } as Parameters<typeof Bun.spawn>[1]);
    shell.proc.exited.then((code) => {
      shell.exitCode = code;
      const note = new TextEncoder().encode(`\r\n\x1b[2m[shell exited with code ${code}]\x1b[0m\r\n`);
      for (const ws of shell.sockets) {
        ws.sendBinary(note);
        ws.close(1000, "exited");
      }
    });
    this.shells.set(shell.id, shell);
    return shell.id;
  }

  /** Replay what the shell printed so far, then stream. */
  attach(ws: ServerWebSocket<ShellSocket>) {
    const s = this.shells.get(ws.data.shell);
    if (!s) return ws.close(4404, "no such shell");
    for (const chunk of s.backlog) ws.sendBinary(chunk);
    if (s.exitCode !== null) return ws.close(1000, "exited");
    s.sockets.add(ws);
  }

  detach(ws: ServerWebSocket<ShellSocket>) {
    this.shells.get(ws.data.shell)?.sockets.delete(ws);
  }

  /** Text frames are JSON control messages ({resize}); binary frames are keystrokes. */
  message(ws: ServerWebSocket<ShellSocket>, message: string | Buffer) {
    const s = this.shells.get(ws.data.shell);
    if (!s || s.exitCode !== null) return;
    const term = (s.proc as unknown as { terminal: { write(d: string | Uint8Array): void; resize(c: number, r: number): void } }).terminal;
    if (typeof message === "string") {
      try {
        const m = JSON.parse(message) as { resize?: [number, number] };
        if (m.resize) term.resize(clamp(m.resize[0], 20, 500), clamp(m.resize[1], 5, 200));
      } catch {}
      return;
    }
    term.write(message);
  }

  close(id: string) {
    const s = this.shells.get(id);
    if (!s) return;
    this.shells.delete(id);
    s.proc.kill("SIGHUP");
    setTimeout(() => s.exitCode === null && s.proc.kill("SIGKILL"), 2000);
    for (const ws of s.sockets) ws.close(1000, "closed");
  }

  closeAll() {
    for (const id of [...this.shells.keys()]) this.close(id);
  }
}
