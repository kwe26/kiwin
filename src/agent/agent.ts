// isol agent: runs *inside* the isolation (as its first process) and acts as
// a tiny systemd. Units are JSON files in $KIWIN_UNITS_DIR (/etc/isol/*.json).
// The host kiwin daemon talks to it over $KIWIN_SOCKET (HTTP over unix socket).
//
// This file must stay dependency-free: it runs on the isolation's own bun.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";

const SOCKET = process.env.KIWIN_SOCKET ?? "/run/kiwin/ctl/agent.sock";
const UNITS_DIR = process.env.KIWIN_UNITS_DIR ?? "/etc/isol";
const LOG_DIR = process.env.KIWIN_LOG_DIR ?? "/var/log/isol";
const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: process.env.LANG ?? "C.UTF-8",
};

type Cmd = string | string[];

interface UnitDef {
  description?: string;
  /** Main process. A string is run with /bin/sh -c. */
  exec: Cmd;
  /** Commands run (in order) before exec; any failure aborts the start. */
  pre?: Cmd[];
  /** Commands run after the main process stopped. */
  post?: Cmd[];
  /** Reload: `reload` command runs first (e.g. a config check), then `reloadSignal` is sent. Neither = restart. */
  reloadSignal?: string;
  reload?: Cmd;
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
  group?: string;
  /** Start automatically when the isolation boots / on daemon-reload. */
  enabled?: boolean;
  restart?: "always" | "on-failure" | "no";
  /** Seconds between restarts. */
  restartSec?: number;
  /** Give up after this many restarts within 60s. */
  restartLimit?: number;
  stopSignal?: string;
  /** Seconds to wait after stopSignal before SIGKILL. */
  stopTimeout?: number;
  /** Units that must be running before this one starts. */
  after?: string[];
}

type State = "stopped" | "starting" | "running" | "stopping" | "backoff" | "failed";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

function argv(cmd: Cmd): string[] {
  return typeof cmd === "string" ? ["/bin/sh", "-c", cmd] : cmd;
}

class Unit {
  state: State = "stopped";
  proc: Subprocess | null = null;
  startedAt: number | null = null;
  exitCode: number | null = null;
  error: string | null = null;
  restarts: number[] = [];
  wanted = false;
  stale = false;
  private ring: string[] = [];
  private followers = new Set<(line: string) => void>();
  private restartTimer: Timer | null = null;

  constructor(public name: string, public def: UnitDef, public file: string) {}

  get logFile() {
    return join(LOG_DIR, `${this.name}.log`);
  }

  write(stream: "out" | "err" | "isol", text: string) {
    const line = `${new Date().toISOString()} [${stream}] ${text}`;
    this.ring.push(line);
    if (this.ring.length > 1000) this.ring.splice(0, this.ring.length - 1000);
    try {
      appendFileSync(this.logFile, line + "\n");
    } catch {}
    for (const f of this.followers) f(line);
  }

  tail(n: number) {
    if (this.ring.length >= n) return this.ring.slice(-n);
    try {
      return readFileSync(this.logFile, "utf8").trimEnd().split("\n").slice(-n);
    } catch {
      return this.ring.slice(-n);
    }
  }

  follow(cb: (line: string) => void) {
    this.followers.add(cb);
    return () => this.followers.delete(cb);
  }

  private spawnArgs(cmd: Cmd) {
    const wrap = ["setsid"];
    if (this.def.user) {
      wrap.push("setpriv", `--reuid=${this.def.user}`, `--regid=${this.def.group ?? this.def.user}`, "--init-groups");
    }
    return {
      cmd: [...wrap, ...argv(cmd)],
      opts: {
        cwd: this.def.cwd ?? "/",
        env: { ...BASE_ENV, ...this.def.env },
        stdin: "ignore" as const,
        stdout: "pipe" as const,
        stderr: "pipe" as const,
      },
    };
  }

  private async runOnce(cmd: Cmd): Promise<number> {
    const { cmd: a, opts } = this.spawnArgs(cmd);
    this.write("isol", `run: ${a.slice(1).join(" ")}`);
    const p = Bun.spawn(a, opts);
    await Promise.all([lines(p.stdout, (l) => this.write("out", l)), lines(p.stderr, (l) => this.write("err", l))]);
    return p.exited;
  }

  async start(): Promise<void> {
    this.wanted = true;
    if (this.state === "running" || this.state === "starting") return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.state = "starting";
    this.error = null;
    try {
      for (const pre of this.def.pre ?? []) {
        const code = await this.runOnce(pre);
        if (code !== 0) throw new Error(`pre command ${JSON.stringify(pre)} exited ${code}`);
      }
      if (!this.wanted) {
        this.state = "stopped";
        return;
      }
      const { cmd, opts } = this.spawnArgs(this.def.exec);
      const proc = Bun.spawn(cmd, opts);
      this.proc = proc;
      this.startedAt = Date.now();
      this.exitCode = null;
      this.state = "running";
      this.write("isol", `started pid ${proc.pid}: ${argv(this.def.exec).join(" ")}`);
      lines(proc.stdout, (l) => this.write("out", l));
      lines(proc.stderr, (l) => this.write("err", l));
      proc.exited.then((code) => this.onExit(proc, code));
    } catch (e) {
      this.state = "failed";
      this.error = String((e as Error).message ?? e);
      this.write("isol", `start failed: ${this.error}`);
    }
  }

  private async onExit(proc: Subprocess, code: number) {
    if (this.proc !== proc) return;
    this.proc = null;
    this.exitCode = code;
    this.write("isol", `exited with code ${code}${proc.signalCode ? ` (${proc.signalCode})` : ""}`);
    // Take down anything left in the process group.
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
    for (const post of this.def.post ?? []) await this.runOnce(post).catch(() => {});

    if (this.state === "stopping" || !this.wanted) {
      this.state = "stopped";
      return;
    }
    const policy = this.def.restart ?? "on-failure";
    if (policy === "no" || (policy === "on-failure" && code === 0)) {
      this.state = code === 0 ? "stopped" : "failed";
      this.wanted = false;
      return;
    }
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60_000);
    if (this.restarts.length >= (this.def.restartLimit ?? 10)) {
      this.state = "failed";
      this.error = "restart limit reached";
      this.wanted = false;
      this.write("isol", "restart limit reached, giving up");
      return;
    }
    this.restarts.push(now);
    this.state = "backoff";
    const delay = (this.def.restartSec ?? 1) * 1000;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted && this.state === "backoff") {
        this.state = "stopped";
        this.start();
      }
    }, delay);
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const proc = this.proc;
    if (!proc) {
      if (this.state !== "failed") this.state = "stopped";
      return;
    }
    this.state = "stopping";
    const sig = (this.def.stopSignal ?? "SIGTERM") as NodeJS.Signals;
    this.write("isol", `stopping (${sig})`);
    try {
      process.kill(-proc.pid, sig);
    } catch {
      proc.kill(sig);
    }
    const timeout = (this.def.stopTimeout ?? 10) * 1000;
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(timeout).then(() => false)]);
    if (!exited) {
      this.write("isol", "stop timeout, sending SIGKILL");
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
      await proc.exited;
    }
    // onExit runs post commands; wait for it to settle.
    while (this.state === "stopping") await Bun.sleep(20);
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async reload() {
    if (!this.proc) throw new Error("not running");
    if (!this.def.reload && !this.def.reloadSignal) return this.restart();
    if (this.def.reload) {
      const code = await this.runOnce(this.def.reload);
      if (code !== 0) throw new Error(`reload exited ${code}`);
    }
    if (this.def.reloadSignal) {
      this.proc.kill(this.def.reloadSignal as NodeJS.Signals);
      this.write("isol", `sent ${this.def.reloadSignal}`);
    }
  }

  info() {
    return {
      name: this.name,
      description: this.def.description ?? "",
      state: this.state,
      enabled: this.def.enabled !== false,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      uptime: this.proc && this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      exitCode: this.exitCode,
      restarts: this.restarts.length,
      error: this.error,
      stale: this.stale,
      exec: argv(this.def.exec),
      file: this.file,
    };
  }
}

async function lines(stream: ReadableStream<Uint8Array> | null | undefined, cb: (l: string) => void) {
  if (!stream) return;
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      cb(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  if (buf) cb(buf);
}

// ---- Unit registry ------------------------------------------------------

const units = new Map<string, Unit>();

function readDefs(): Map<string, { def: UnitDef; file: string }> {
  const defs = new Map<string, { def: UnitDef; file: string }>();
  if (!existsSync(UNITS_DIR)) return defs;
  for (const f of readdirSync(UNITS_DIR).sort()) {
    if (!f.endsWith(".json")) continue;
    const file = join(UNITS_DIR, f);
    try {
      const def = JSON.parse(readFileSync(file, "utf8")) as UnitDef;
      if (!def.exec) throw new Error("missing exec");
      defs.set(basename(f, ".json"), { def, file });
    } catch (e) {
      log(`skipping ${file}: ${(e as Error).message}`);
    }
  }
  return defs;
}

/** Re-read unit files. Returns what changed. */
async function daemonReload() {
  const defs = readDefs();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, u] of units) {
    if (!defs.has(name)) {
      await u.stop();
      units.delete(name);
      removed.push(name);
    }
  }
  for (const [name, { def, file }] of defs) {
    const u = units.get(name);
    if (!u) {
      units.set(name, new Unit(name, def, file));
      added.push(name);
    } else if (JSON.stringify(u.def) !== JSON.stringify(def)) {
      u.def = def;
      // Takes effect on next (re)start, like systemd.
      u.stale = u.state === "running";
      changed.push(name);
    }
  }
  await startEnabled(added);
  return { added, removed, changed };
}

/** Start enabled units, honouring `after` ordering. */
async function startEnabled(names: string[] = [...units.keys()]) {
  const pending = new Set(names.filter((n) => units.get(n)?.def.enabled !== false));
  const started = new Set<string>();
  const visit = async (name: string, chain: string[] = []) => {
    if (started.has(name) || chain.includes(name)) return;
    const u = units.get(name);
    if (!u) return;
    for (const dep of u.def.after ?? []) {
      if (units.has(dep) && units.get(dep)!.state !== "running") await visit(dep, [...chain, name]);
    }
    started.add(name);
    await u.start();
  };
  for (const n of pending) await visit(n);
}

async function shutdown() {
  log("shutting down units");
  // Reverse dependency order: stop units nobody depends on first.
  const order = [...units.values()].sort(
    (a, b) => (b.def.after?.length ?? 0) - (a.def.after?.length ?? 0),
  );
  await Promise.all(order.map((u) => u.stop()));
}

// ---- Process listing ----------------------------------------------------

function processes() {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const status = readFileSync(`/proc/${d}/status`, "utf8");
      const field = (k: string) => status.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1] ?? "";
      const cmdline = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      let unit: string | null = null;
      const pgid = Number(readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1]?.split(" ")[2]);
      for (const u of units.values()) if (u.proc && u.proc.pid === pgid) unit = u.name;
      out.push({
        pid: Number(d),
        ppid: Number(field("PPid")),
        uid: Number(field("Uid").split(/\s+/)[0]),
        state: field("State"),
        rssKb: Number(field("VmRSS").split(/\s+/)[0] || 0),
        unit,
        cmd: cmdline || `[${field("Name")}]`,
        exe: (() => {
          try {
            return readlinkSync(`/proc/${d}/exe`);
          } catch {
            return null;
          }
        })(),
      });
    } catch {}
  }
  return out;
}

// ---- Control API --------------------------------------------------------

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method;

  if (method === "GET" && url.pathname === "/health") return json({ ok: true, pid: process.pid });
  if (method === "GET" && url.pathname === "/units") return json([...units.values()].map((u) => u.info()));
  if (method === "GET" && url.pathname === "/ps") return json(processes());
  if (method === "POST" && url.pathname === "/daemon-reload") return json(await daemonReload());
  if (method === "POST" && url.pathname === "/kill") {
    const { pid, signal = "SIGTERM" } = (await req.json()) as { pid: number; signal?: string };
    if (!Number.isInteger(pid) || pid <= 1) return json({ error: "invalid pid" }, 400);
    try {
      process.kill(pid, signal as NodeJS.Signals);
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }
  if (method === "POST" && url.pathname === "/shutdown") {
    await shutdown();
    setTimeout(() => process.exit(0), 50);
    return json({ ok: true });
  }

  if (parts[0] === "units" && parts[1]) {
    const u = units.get(parts[1]);
    if (!u) return json({ error: `unit ${parts[1]} not found` }, 404);
    const action = parts[2];
    if (method === "GET" && !action) return json(u.info());
    if (method === "GET" && action === "logs") {
      const n = Number(url.searchParams.get("lines") ?? 100);
      const backlog = u.tail(n);
      if (url.searchParams.get("follow") !== "1") return new Response(backlog.join("\n") + "\n");
      let unsub = () => {};
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(ctrl) {
            if (backlog.length) ctrl.enqueue(enc.encode(backlog.join("\n") + "\n"));
            unsub = u.follow((l) => ctrl.enqueue(enc.encode(l + "\n")));
          },
          cancel() {
            unsub();
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    }
    if (method === "POST") {
      try {
        switch (action) {
          case "start":
            await u.start();
            break;
          case "stop":
            await u.stop();
            break;
          case "restart":
            await u.restart();
            u.stale = false;
            break;
          case "reload":
            await u.reload();
            break;
          case "enable":
          case "disable": {
            u.def.enabled = action === "enable";
            writeFileSync(u.file, JSON.stringify(u.def, null, 2) + "\n");
            break;
          }
          default:
            return json({ error: `unknown action ${action}` }, 400);
        }
        return json(u.info());
      } catch (e) {
        return json({ error: String((e as Error).message ?? e), unit: u.info() }, 500);
      }
    }
  }
  return json({ error: "not found" }, 404);
}

// ---- Boot ---------------------------------------------------------------

mkdirSync(LOG_DIR, { recursive: true });
rmSync(SOCKET, { force: true });
Bun.serve({ unix: SOCKET, fetch: handle, idleTimeout: 0 });
log(`isol agent up (pid ${process.pid}), units from ${UNITS_DIR}, socket ${SOCKET}`);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    await shutdown();
    process.exit(0);
  });
}

for (const [name, { def, file }] of readDefs()) units.set(name, new Unit(name, def, file));
await startEnabled();
log(`started: ${[...units.values()].filter((u) => u.state === "running").map((u) => u.name).join(", ") || "(none)"}`);
