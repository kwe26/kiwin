import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import type { KiwinConfig } from "./config";
import type { Sandbox } from "./sandbox";

/** Host pids of everything in the isolation's pid namespace. */
export function isolationPids(initPid: number): number[] {
  const ns = readlinkSync(`/proc/${initPid}/ns/pid`);
  const pids: number[] = [];
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try {
      if (readlinkSync(`/proc/${e}/ns/pid`) === ns) pids.push(Number(e));
    } catch {} // gone already
  }
  return pids;
}

const signalAll = (pids: number[], signal: NodeJS.Signals) => {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
};

/** Pids among `pids` that listen on a TCP port (the network namespace is shared with the host). */
function listeners(pids: number[], port: number): number[] {
  const inodes = new Set<string>();
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {}
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1]?.endsWith(`:${hex}`) && f[3] === "0A") inodes.add(f[9]);
    }
  }
  return pids.filter((pid) => {
    try {
      return readdirSync(`/proc/${pid}/fd`).some((fd) => {
        try {
          return inodes.has(/^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1] ?? "");
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  });
}

/** Kill whatever in the isolation listens on `port` (the panel, when it must give the port up). */
export function killListeners(initPid: number, port: number) {
  signalAll(listeners(isolationPids(initPid), port), "SIGKILL");
}

/**
 * Stop everything in the isolation so the host can breathe, and kill whatever
 * holds the recovery port (the panel): a stopped process would keep the socket.
 * The supervisor inside is stopped too, so it restarts the panel only on resume.
 */
export function pauseIsolation(initPid: number, port: number) {
  // Twice, for anything forked while the first pass ran.
  signalAll(isolationPids(initPid), "SIGSTOP");
  const pids = isolationPids(initPid);
  signalAll(pids, "SIGSTOP");
  signalAll(listeners(pids, port), "SIGKILL");
}

export function resumeIsolation(initPid: number) {
  signalAll(isolationPids(initPid), "SIGCONT");
}

function cpuTimes() {
  const f = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  return { idle: f[3] + f[4], total: f.reduce((a, b) => a + b, 0) };
}

function memoryPercent() {
  const info = readFileSync("/proc/meminfo", "utf8");
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? 0);
  const total = kb("MemTotal");
  return total ? 100 - (kb("MemAvailable") / total) * 100 : 0;
}

const TICK_MS = 5000;
const CRASH_WINDOW_MS = 3 * 60_000;
const CRASH_LIMIT = 5;
/** A panel that is still starting doesn't answer yet; that is not a hang. */
const STARTUP_GRACE_MS = 3 * 60_000;

/**
 * Finds a hung system. High use alone is normal (a build, a backup), so a hang
 * is 99% CPU or memory for hangSeconds while the panel doesn't answer either.
 */
export class Watchdog {
  private timer: Timer | null = null;
  private last = cpuTimes();
  private highSince: number | null = null;
  private snoozedUntil = 0;
  private launches: { at: number; count: number }[] = [];

  constructor(
    private cfg: KiwinConfig,
    private sandbox: Sandbox,
    /** False while recovery has the port. */
    private watching: () => boolean,
    private onHang: (detail: string) => void,
    private onCrashLoop: (detail: string) => void,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** After a Force Resume, give the system time to catch up before judging it again. */
  snooze(ms: number) {
    this.snoozedUntil = Date.now() + ms;
    this.highSince = null;
    this.launches = [];
  }

  private async panelAnswers() {
    try {
      await fetch(`http://127.0.0.1:${this.cfg.recovery.port}/`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      return false;
    }
  }

  private async tick() {
    const now = Date.now();
    const cur = cpuTimes();
    const total = cur.total - this.last.total;
    const cpu = total > 0 ? 100 - ((cur.idle - this.last.idle) / total) * 100 : 0;
    this.last = cur;
    if (!this.watching() || now < this.snoozedUntil) {
      this.highSince = null;
      return;
    }

    this.launches = [...this.launches, { at: now, count: this.sandbox.launches }].filter((l) => now - l.at < CRASH_WINDOW_MS);
    if (this.sandbox.launches - this.launches[0].count >= CRASH_LIMIT) {
      this.launches = [];
      return this.onCrashLoop(`The isolation exited ${CRASH_LIMIT} times in ${CRASH_WINDOW_MS / 60_000} minutes.`);
    }

    const memory = memoryPercent();
    const limit = this.cfg.recovery.hangPercent;
    if (cpu < limit && memory < limit) {
      this.highSince = null;
      return;
    }
    this.highSince ??= now;
    if (now - this.highSince < this.cfg.recovery.hangSeconds * 1000) return;
    if (!this.sandbox.startedAt || now - this.sandbox.startedAt < STARTUP_GRACE_MS) return;
    if (await this.panelAnswers()) return;
    if (!this.watching()) return;
    this.highSince = null;
    const what = cpu >= limit ? `CPU at ${Math.round(cpu)}%` : `Memory at ${Math.round(memory)}%`;
    this.onHang(`${what} for over ${this.cfg.recovery.hangSeconds} seconds, and the panel stopped answering.`);
  }
}
