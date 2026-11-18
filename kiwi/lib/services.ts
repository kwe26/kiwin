import { agent } from "./host";

// isol units (the systemd-like services inside the isolation) for the panel.

const AGENT_SOCKET = process.env.KIWIN_SOCKET ?? "/run/kiwin/ctl/agent.sock";
const UNIT = /^[A-Za-z0-9_.-]{1,64}$/;
/** Stopping/restarting these from the panel would take the panel itself down. */
const PROTECTED = new Set(["kiwin"]);

export interface UnitInfo {
    name: string;
    description: string;
    state: string;
    enabled: boolean;
    pid: number | null;
    uptime: number | null;
    restarts: number;
    error: string | null;
}

export type UnitOp = "start" | "stop" | "restart" | "reload";

export class KiwiServices {
    static async list(): Promise<UnitInfo[]> {
        try {
            return await agent<UnitInfo[]>("/units");
        } catch {
            return [];
        }
    }

    static isProtected(name: string): boolean {
        return PROTECTED.has(name);
    }

    static async run(name: string, op: UnitOp): Promise<UnitInfo> {
        if (!UNIT.test(name)) throw new Error("Invalid service name");
        if (PROTECTED.has(name) && op !== "reload") throw new Error(`${name} runs this panel, so it cannot be ${op === "stop" ? "stopped" : `${op}ed`} from here`);
        return agent<UnitInfo>(`/units/${name}/${op}`, {});
    }

    static async logs(name: string, lines = 60): Promise<string> {
        if (!UNIT.test(name)) throw new Error("Invalid service name");
        const res = await fetch(`http://kiwin/units/${name}/logs?lines=${lines}`, { unix: AGENT_SOCKET } as RequestInit);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.text()).trimEnd();
    }
}

export function formatUptime(s: number | null): string {
    if (s === null) return "-";
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function formatBytes(n: number | null): string {
    if (n === null) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
