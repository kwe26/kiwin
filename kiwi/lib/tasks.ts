import { readdirSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { agent } from "./host";

// Task manager for the panel. kiwi runs inside the isolation's own PID
// namespace, so /proc here lists only the isolation's processes, never the
// host's. CPU use comes from /proc tick deltas between samples, as a share of
// the whole machine (100% = every core busy), like Windows' Task Manager.

export interface TaskProcess {
    pid: number;
    ppid: number;
    name: string;
    command: string;
    user: string;
    /** R running, S sleeping, D disk wait, T stopped (suspended), Z zombie, I idle. */
    state: string;
    cpu: number;
    rssBytes: number;
    /** Bytes of this process swapped out (VmSwap). */
    swapBytes: number;
    threads: number;
    /** isol unit (service) the process belongs to, if any. */
    unit: string | null;
    /** The panel itself and the isolation's init: not signalled from here. */
    protected: boolean;
}

export interface TaskSample {
    t: number;
    /** % of all CPUs used by the isolation. */
    cpu: number;
    /** Bytes of RAM used by the isolation's processes (sum of RSS). */
    mem: number;
    /** Bytes of swap in use on the whole machine. */
    swap: number;
}

export interface TaskSnapshot {
    cpus: number;
    memTotal: number;
    memAvailable: number;
    swapTotal: number;
    /** Swap used by the isolation's processes (sum of VmSwap). */
    swapIsolation: number;
    current: TaskSample;
    history: TaskSample[];
    processes: TaskProcess[];
}

export type TaskAction = "suspend" | "resume" | "terminate" | "kill";

const SIGNALS: Record<TaskAction, NodeJS.Signals> = { suspend: "SIGSTOP", resume: "SIGCONT", terminate: "SIGTERM", kill: "SIGKILL" };
const HISTORY = 60;
const INTERVAL_MS = 1000;
const IDLE_STOP_MS = 15_000;
const PAGE = 4096;

interface State {
    prevTotal: number;
    prevTicks: Map<number, number>;
    history: TaskSample[];
    processes: TaskProcess[];
    memTotal: number;
    memAvailable: number;
    swapTotal: number;
    swapIsolation: number;
    lastRequest: number;
    timer: ReturnType<typeof setInterval> | null;
    units: Map<number, string>;
    unitsAt: number;
}

// One sampler shared by every viewer (and every copy of this module Next.js loads).
const state = ((globalThis as any).__kiwiTasks ??= {
    prevTotal: 0, prevTicks: new Map(), history: [], processes: [], memTotal: 0, memAvailable: 0, swapTotal: 0, swapIsolation: 0,
    lastRequest: 0, timer: null, units: new Map(), unitsAt: 0,
}) as State;

function totalTicks(): number {
    const cpu = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    return cpu.reduce((a, b) => a + b, 0);
}

function meminfo() {
    const text = readFileSync("/proc/meminfo", "utf8");
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0) * 1024;
    return { total: kb("MemTotal"), available: kb("MemAvailable"), swapTotal: kb("SwapTotal"), swapFree: kb("SwapFree") };
}

function users(): Map<number, string> {
    const out = new Map<number, string>();
    try {
        for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
            const f = line.split(":");
            if (f.length > 2) out.set(Number(f[2]), f[0]);
        }
    } catch {}
    return out;
}

/** Unit main pids (refreshed every few seconds; units start processes with setsid, so pid = session id). */
async function refreshUnits() {
    if (Date.now() - state.unitsAt < 5000) return;
    state.unitsAt = Date.now();
    try {
        const list = await agent<{ name: string; pid: number | null }[]>("/units");
        state.units = new Map(list.filter((u) => u.pid).map((u) => [u.pid!, u.name]));
    } catch {}
}

function sample() {
    const total = totalTicks();
    const dTotal = state.prevTotal ? total - state.prevTotal : 0;
    const names = users();
    const ticks = new Map<number, number>();
    const procs: TaskProcess[] = [];
    let cpuSum = 0;
    let memSum = 0;
    let swapSum = 0;
    for (const d of readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        const pid = Number(d);
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            // comm may contain spaces and parentheses: split after the last ")".
            const close = stat.lastIndexOf(")");
            const comm = stat.slice(stat.indexOf("(") + 1, close);
            const f = stat.slice(close + 2).split(" ");
            const [state_, ppid, , session] = [f[0], Number(f[1]), Number(f[2]), Number(f[3])];
            const t = Number(f[11]) + Number(f[12]); // utime + stime
            const threads = Number(f[17]);
            const rss = Number(f[21]) * PAGE;
            ticks.set(pid, t);
            const prev = state.prevTicks.get(pid);
            const cpu = dTotal > 0 && prev !== undefined ? Math.max(0, ((t - prev) / dTotal) * 100) : 0;
            const status = readFileSync(`/proc/${pid}/status`, "utf8");
            const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
            const swap = Number(/^VmSwap:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
            const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
            cpuSum += cpu;
            memSum += rss;
            swapSum += swap;
            procs.push({
                pid,
                ppid,
                name: comm,
                command: cmdline || `[${comm}]`,
                user: names.get(uid) ?? String(uid),
                state: state_,
                cpu: Math.round(cpu * 10) / 10,
                rssBytes: rss,
                swapBytes: swap,
                threads,
                unit: state.units.get(session) ?? state.units.get(pid) ?? null,
                protected: pid === 1 || pid === process.pid,
            });
        } catch {
            // Exited while we were reading it.
        }
    }
    // A process's children inherit its unit (e.g. a shell started by a service).
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    for (const p of procs) {
        let q: TaskProcess | undefined = p;
        for (let i = 0; !p.unit && q && i < 64; i++) {
            p.unit = q.unit;
            q = byPid.get(q.ppid);
        }
    }
    const mem = meminfo();
    state.prevTotal = total;
    state.prevTicks = ticks;
    state.processes = procs;
    state.memTotal = mem.total;
    state.memAvailable = mem.available;
    state.swapTotal = mem.swapTotal;
    state.swapIsolation = swapSum;
    if (dTotal > 0) {
        state.history.push({ t: Date.now(), cpu: Math.round(cpuSum * 10) / 10, mem: memSum, swap: Math.max(0, mem.swapTotal - mem.swapFree) });
        if (state.history.length > HISTORY) state.history.splice(0, state.history.length - HISTORY);
    }
}

export class KiwiTasks {
    /** Latest sample; starts the 1s sampler, which stops again when nobody has asked for a while. */
    static async snapshot(): Promise<TaskSnapshot> {
        state.lastRequest = Date.now();
        await refreshUnits();
        if (!state.timer) {
            sample();
            await Bun.sleep(300); // a first delta, so CPU isn't all zero
            sample();
            state.timer = setInterval(() => {
                if (Date.now() - state.lastRequest > IDLE_STOP_MS) {
                    clearInterval(state.timer!);
                    state.timer = null;
                    return;
                }
                void refreshUnits();
                try {
                    sample();
                } catch {}
            }, INTERVAL_MS);
            (state.timer as { unref?: () => void }).unref?.();
        }
        const last = state.history[state.history.length - 1] ?? { t: Date.now(), cpu: 0, mem: 0, swap: 0 };
        return {
            cpus: cpus().length,
            memTotal: state.memTotal,
            memAvailable: state.memAvailable,
            swapTotal: state.swapTotal,
            swapIsolation: state.swapIsolation,
            current: last,
            history: state.history,
            processes: state.processes,
        };
    }

    static signal(pid: number, action: TaskAction): void {
        if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid process id");
        if (!(action in SIGNALS)) throw new Error("Unknown action");
        if (pid === 1) throw new Error("PID 1 is the isolation's service manager; restart the isolation from the host instead");
        if (pid === process.pid) throw new Error("That is the panel itself");
        try {
            process.kill(pid, SIGNALS[action]);
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            throw new Error(code === "ESRCH" ? "The process has already exited" : code === "EPERM" ? "Not allowed to signal that process" : (e as Error).message);
        }
    }
}
