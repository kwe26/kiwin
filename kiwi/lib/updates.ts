import { host } from "./host";

export interface Release {
    tag: string;
    version: string;
    name: string;
    publishedAt: string;
    prerelease: boolean;
    notes: string;
    pageUrl: string;
    size: number;
}

export interface UpdateInfo {
    current: string;
    latest: Release | null;
    available: boolean;
    checkedAt: number | null;
    error: string | null;
    last: { ok: boolean; at: number } | null;
}

// The host daemon checks GitHub, downloads and upgrades: nothing inside the
// isolation can change what gets installed.
export class KiwiUpdates {
    static info(): Promise<UpdateInfo> {
        return host<UpdateInfo>("/updates");
    }

    static check(): Promise<UpdateInfo> {
        return host<UpdateInfo>("/updates/check", {});
    }

    /** Stops the panel (the system keeps running) and opens /recovery in its place. */
    static async openRecovery(): Promise<void> {
        await host("/recovery/open", {});
    }

    /** Shuts the system down and returns a one-time link token for the upgrade page. */
    static async enter(): Promise<string> {
        return (await host<{ token: string }>("/updates/enter", {})).token;
    }
}
