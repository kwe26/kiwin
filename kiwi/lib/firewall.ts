import { host } from "./host";

// Host firewall (nftables, managed by the kiwin daemon; see src/firewall.ts).
// kiwi only edits the list of allowed incoming ports through the host API.

export type Proto = "tcp" | "udp";

export interface FirewallRule {
    port: number;
    to?: number;
    proto: Proto;
    comment?: string;
}

export interface ListeningSocket {
    proto: Proto;
    address: string;
    port: number;
    scope: "public" | "local";
    process: string | null;
    pid: number | null;
    isolated: boolean;
}

export interface FirewallInfo {
    available: boolean;
    enabled: boolean;
    rules: FirewallRule[];
    protectedPorts: number[];
    pending: { revertAt: number } | null;
    ufwActive: boolean;
    lastError: string | null;
    listening: ListeningSocket[];
}

export const covers = (r: FirewallRule, proto: Proto, port: number) => r.proto === proto && port >= r.port && port <= (r.to ?? r.port);

export class KiwiFirewall {
    static info(): Promise<FirewallInfo> {
        return host<FirewallInfo>("/firewall");
    }

    /** Whether new connections to proto/port get through. */
    static allows(info: Pick<FirewallInfo, "enabled" | "rules" | "protectedPorts">, proto: Proto, port: number): boolean {
        if (!info.enabled) return true;
        if (proto === "tcp" && info.protectedPorts.includes(port)) return true;
        return info.rules.some((r) => covers(r, proto, port));
    }

    /** Apply a new state. `needsConfirm`: it closes something and is rolled back unless confirmed. */
    static update(enabled: boolean, rules: FirewallRule[]): Promise<{ ok: boolean; needsConfirm?: boolean; error?: string }> {
        return host("/firewall", { enabled, rules });
    }

    static confirm() {
        return host<{ ok: boolean }>("/firewall/confirm", {});
    }

    static revert() {
        return host<{ ok: boolean }>("/firewall/revert", {});
    }
}
