import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { host } from "./host";
import { KiwiPhp } from "./php";

// Status of the isolation (from the host daemon) and of the Ubuntu system
// running inside it (read directly; kiwi runs inside the isolation).

export interface IsolationStatus {
    running: boolean;
    startedAt: number | null;
    launches: number;
    lastExit: number | null;
    rootless: boolean;
    hostname: string;
    daemonStartedAt: number;
    images: { system: boolean; user: boolean };
    ssh: { port: number } | null;
    bwrap: string;
}

export interface Disk {
    mount: string;
    total: number;
    used: number;
}

export interface UbuntuStatus {
    pretty: string;
    version: string;
    codename: string;
    kernel: string;
    arch: string;
    hostname: string;
    cpus: number;
    cpuModel: string;
    load: [number, number, number];
    memTotal: number;
    memAvailable: number;
    processes: number;
    packages: number | null;
    disks: Disk[];
    components: { name: string; version: string | null }[];
}

function osRelease(): Record<string, string> {
    try {
        return Object.fromEntries(
            readFileSync("/etc/os-release", "utf8").split("\n")
                .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
                .filter((m): m is RegExpMatchArray => !!m)
                .map((m) => [m[1], m[2].replace(/^"|"$/g, "")]),
        );
    } catch {
        return {};
    }
}

function meminfo(): { total: number; available: number } {
    try {
        const text = readFileSync("/proc/meminfo", "utf8");
        const kb = (k: string) => Number(text.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
        return { total: kb("MemTotal"), available: kb("MemAvailable") };
    } catch {
        return { total: os.totalmem(), available: os.freemem() };
    }
}

function disk(mount: string): Disk | null {
    try {
        const s = statfsSync(mount);
        const total = s.blocks * s.bsize;
        return { mount, total, used: total - s.bavail * s.bsize };
    } catch {
        return null;
    }
}

function dpkgCount(): number | null {
    try {
        return readFileSync("/var/lib/dpkg/status", "utf8").split("\n").filter((l) => l === "Status: install ok installed").length;
    } catch {
        return null;
    }
}

function version(cmd: string[], pattern: RegExp): string | null {
    if (!existsSync(cmd[0])) return null;
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return (p.stdout.toString() + p.stderr.toString()).match(pattern)?.[1] ?? "installed";
}

// Version probes spawn processes; cache them briefly.
let componentsCache: { at: number; value: UbuntuStatus["components"] } | null = null;
function components(): UbuntuStatus["components"] {
    if (componentsCache && Date.now() - componentsCache.at < 60_000) return componentsCache.value;
    const value = [
        { name: "nginx", version: version(["/usr/sbin/nginx", "-v"], /nginx\/([\d.]+)/) },
        { name: "MySQL", version: version(["/usr/sbin/mysqld", "--version"], /Ver ([\d.]+)/) },
        ...KiwiPhp.versions().map((v) => ({ name: `PHP ${v}`, version: version([...KiwiPhp.fpmCommand(v), "-v"], /PHP ([\d.]+)/) })),
        { name: "Bun", version: Bun.version },
    ];
    componentsCache = { at: Date.now(), value };
    return value;
}

export class KiwiSystem {
    /** Isolation status from the host daemon; null if unreachable or the daemon is older than this panel. */
    static async isolation(): Promise<IsolationStatus | null> {
        try {
            return await host<IsolationStatus>("/isolation");
        } catch {
            return null;
        }
    }

    static ubuntu(): UbuntuStatus {
        const rel = osRelease();
        const mem = meminfo();
        const cpus = os.cpus();
        return {
            pretty: rel.PRETTY_NAME ?? "Linux",
            version: rel.VERSION_ID ?? "",
            codename: rel.VERSION_CODENAME ?? "",
            kernel: os.release(),
            arch: os.arch(),
            hostname: os.hostname(),
            cpus: cpus.length,
            cpuModel: cpus[0]?.model?.replace(/\s+/g, " ").trim() ?? "",
            load: os.loadavg() as [number, number, number],
            memTotal: mem.total,
            memAvailable: mem.available,
            // /proc only shows the isolation's own pid namespace.
            processes: readdirSync("/proc").filter((d) => /^\d+$/.test(d)).length,
            packages: dpkgCount(),
            disks: [disk("/"), disk("/www")].filter((d): d is Disk => !!d && d.total > 0),
            components: components(),
        };
    }
}

export function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${s}s`;
}
