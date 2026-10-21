import { chownSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import type { Subprocess } from "bun";
import { INSIDE, ROOT, paths, type KiwinConfig } from "./config";

export const isRoot = () => process.getuid?.() === 0;

/**
 * Ubuntu's AppArmor profile `bwrap-userns-restrict` attaches to /usr/bin/bwrap
 * and moves every child into `unpriv_bwrap`, which denies *all* capabilities,
 * even when bwrap runs as root. Root inside then can't bind :80, setuid, or
 * override file permissions. The profile matches by path, so as root we run a
 * root-owned private copy instead (capabilities are still trimmed via --cap-drop).
 */
export const PRIVATE_BWRAP = "/usr/local/lib/kiwin/bwrap";

export function resolveBwrap(log: (l: string) => void): string {
  if (!isRoot()) return "bwrap";
  const system = Bun.which("bwrap");
  if (!system) throw new Error("bwrap not found in PATH");
  const src = readFileSync(system);
  let current: Buffer | null = null;
  try {
    current = readFileSync(PRIVATE_BWRAP);
  } catch {}
  if (!current || !current.equals(src)) {
    mkdirSync(dirname(PRIVATE_BWRAP), { recursive: true, mode: 0o755 });
    writeFileSync(PRIVATE_BWRAP + ".tmp", src, { mode: 0o755 });
    chownSync(PRIVATE_BWRAP + ".tmp", 0, 0);
    renameSync(PRIVATE_BWRAP + ".tmp", PRIVATE_BWRAP);
    log(`installed private bwrap copy at ${PRIVATE_BWRAP} (from ${system})`);
  }
  return PRIVATE_BWRAP;
}

/** AppArmor label of a process, e.g. "unconfined" or "bwrap//&unpriv_bwrap (enforce)". */
export function apparmorLabel(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/attr/current`, "utf8").replace(/\0/g, "").trim();
  } catch {
    return null;
  }
}

const SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function bwrapArgs(cfg: KiwinConfig): string[] {
  const p = paths(cfg);
  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    // Network namespace is intentionally shared: anything listening inside
    // binds directly on the host (0.0.0.0:*), and outbound access just works.
    "--hostname", cfg.hostname,
    "--bind", cfg.rootfs, "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/run",
    "--dir", "/run/lock",
    "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind", p.agentSrc, INSIDE.agentDir,
    "--bind", p.ctlDir, INSIDE.ctlDir,
  ];
  if (!isRoot()) {
    // Developer mode: unprivileged user namespace with a fake root.
    args.unshift("--unshare-user", "--uid", "0", "--gid", "0");
  } else {
    for (const cap of cfg.dropCaps) args.push("--cap-drop", cap);
  }
  for (const t of cfg.tmpfs) args.push("--tmpfs", t);
  for (const b of cfg.binds) {
    args.push(b.ro ? "--ro-bind" : "--bind", b.src, b.dest);
    // kiwin's own directory stays visible but read-only (root inside must not
    // rewrite code the host runs as root); the rootfs and state (ssh host key,
    // control sockets) are hidden entirely.
    const inside = (p: string) => {
      const rel = relative(b.src, p);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? join(b.dest, rel) : null;
    };
    const kiwin = inside(ROOT);
    if (kiwin) args.push("--ro-bind", ROOT, kiwin);
    for (const hidden of [cfg.rootfs, cfg.stateDir]) {
      const at = inside(hidden);
      if (at) args.push("--tmpfs", at);
    }
  }
  args.push(
    "--clearenv",
    "--setenv", "PATH", SANDBOX_PATH,
    "--setenv", "HOME", "/root",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "KIWIN_SOCKET", INSIDE.agentSock,
    "--setenv", "KIWIN_UNITS_DIR", cfg.agent.unitsDir,
    "--setenv", "KIWIN_LOG_DIR", cfg.agent.logDir,
    "--chdir", "/",
    "--",
    cfg.agent.bun, join(INSIDE.agentDir, "agent.ts"),
  );
  return args;
}

/** Find the pid (in host terms) of the isolation's pid 1, which we can nsenter into. */
function findInitPid(bwrapPid: number): number | null {
  try {
    const children = readFileSync(`/proc/${bwrapPid}/task/${bwrapPid}/children`, "utf8").trim().split(/\s+/);
    const self = readlinkSync("/proc/self/ns/pid");
    for (const c of children) {
      if (c && readlinkSync(`/proc/${c}/ns/pid`) !== self) return Number(c);
    }
  } catch {}
  return null;
}

export class Sandbox {
  proc: Subprocess | null = null;
  initPid: number | null = null;
  startedAt: number | null = null;
  launches = 0;
  lastExit: number | null = null;
  private stopping = false;
  private onLog: (line: string) => void;

  constructor(private cfg: KiwinConfig, onLog: (line: string) => void) {
    this.onLog = onLog;
  }

  get running() {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  async start() {
    this.stopping = false;
    const args = bwrapArgs(this.cfg);
    const bwrap = resolveBwrap(this.onLog);
    this.onLog(`launching isolation: ${bwrap} ${args.join(" ")}`);
    const proc = Bun.spawn([bwrap, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    this.launches++;
    this.startedAt = Date.now();
    this.initPid = null;
    pipeLines(proc.stdout, (l) => this.onLog(`[isol] ${l}`));
    pipeLines(proc.stderr, (l) => this.onLog(`[isol] ${l}`));

    proc.exited.then((code) => {
      this.lastExit = code;
      this.initPid = null;
      if (this.proc === proc) this.proc = null;
      this.onLog(`isolation exited with code ${code}`);
      if (!this.stopping) {
        setTimeout(() => !this.stopping && !this.running && this.start(), this.cfg.restartDelay * 1000);
      }
    });

    for (let i = 0; i < 100 && this.running && !this.initPid; i++) {
      this.initPid = findInitPid(proc.pid);
      if (!this.initPid) await Bun.sleep(50);
    }
    if (this.initPid) {
      this.onLog(`isolation up (bwrap pid ${proc.pid}, init pid ${this.initPid})`);
      const label = apparmorLabel(this.initPid);
      if (isRoot() && label?.includes("unpriv_bwrap")) {
        this.onLog(`warning: isolation is confined by AppArmor (${label}); root inside has no capabilities`);
      }
    }
  }

  async stop(timeoutMs = 30_000) {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;
    // Ask the agent to stop units gracefully first.
    await agentFetch(this.cfg, "/shutdown", { method: "POST" }, timeoutMs).catch(() => {});
    const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!done) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  }
}

export function agentFetch(cfg: KiwinConfig, path: string, init: RequestInit = {}, timeoutMs = 10_000) {
  return fetch(`http://isol${path}`, {
    ...init,
    unix: paths(cfg).agentSock,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  } as RequestInit);
}

export async function pipeLines(stream: ReadableStream<Uint8Array> | null | undefined, cb: (line: string) => void) {
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

// ---- Accounts inside the isolation -------------------------------------

export interface Account {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

/**
 * Read a file from the isolation's rootfs without following symlinks that
 * escape it (root inside controls those files).
 */
export function readRootfsFile(cfg: KiwinConfig, insidePath: string): string | null {
  try {
    const rootReal = realpathSync(cfg.rootfs);
    const real = realpathSync(join(cfg.rootfs, insidePath));
    if (!real.startsWith(rootReal + "/")) return null;
    return readFileSync(real, "utf8");
  } catch {
    return null;
  }
}

export function lookupAccount(cfg: KiwinConfig, name: string): Account | null {
  if (!/^[a-z_][a-z0-9_.-]*\$?$/i.test(name)) return null;
  const passwd = readRootfsFile(cfg, "/etc/passwd") ?? "";
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f[0] === name && f.length >= 7) {
      return { name, uid: Number(f[2]), gid: Number(f[3]), home: f[5] || "/", shell: f[6] || "/bin/sh" };
    }
  }
  return null;
}

export interface EnterOptions {
  /** Command string run through the user's shell (`shell -c`); omitted = login shell. */
  command?: string;
  term?: string;
  env?: Record<string, string>;
}

/** argv that runs a process inside the live isolation as `account`. */
export function enterCommand(cfg: KiwinConfig, initPid: number, account: Account, opts: EnterOptions = {}): string[] {
  const ns = ["nsenter", "-t", String(initPid), "-m", "-u", "-i", "-p", "-r", "-w"];
  if (!isRoot()) ns.push("-U", "--preserve-credentials");

  const env = [
    `HOME=${account.home}`,
    `USER=${account.name}`,
    `LOGNAME=${account.name}`,
    `SHELL=${account.shell}`,
    `PATH=${SANDBOX_PATH}`,
    `LANG=C.UTF-8`,
    ...(opts.term ? [`TERM=${opts.term}`] : []),
    ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
  ];

  const priv: string[] = [];
  if (isRoot()) {
    const caps = cfg.dropCaps.map((c) => "-" + c.replace(/^CAP_/, "").toLowerCase());
    priv.push(`--bounding-set=${caps.join(",")}`);
    if (account.uid !== 0) priv.push(`--reuid=${account.uid}`, `--regid=${account.gid}`, "--init-groups");
  }

  const shellArgs = opts.command !== undefined ? [account.shell, "-c", opts.command] : [account.shell, "-l"];
  return [
    ...ns,
    "/usr/bin/env", "-i", ...env,
    ...(priv.length ? ["/usr/bin/setpriv", ...priv] : []),
    "/bin/sh", "-c", 'cd "$HOME" 2>/dev/null || cd /; exec "$@"', "kiwin-login",
    ...shellArgs,
  ];
}
