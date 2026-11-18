import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// Talking to the kiwin daemon (host side) and the isol agent (inside) from kiwi.

const HOST_SOCKET = process.env.KIWIN_HOST_SOCKET ?? "/run/kiwin/host/host.sock";
const AGENT_SOCKET = process.env.KIWIN_SOCKET ?? "/run/kiwin/ctl/agent.sock";

async function call<T>(socket: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`http://kiwin${path}`, {
        method: body === undefined ? "GET" : "POST",
        unix: socket,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    } as RequestInit);
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

/** Host daemon API (runs as host root; narrow on purpose). */
export const host = <T>(path: string, body?: unknown) => call<T>(HOST_SOCKET, path, body);

/** isol agent API (unit management inside the isolation). */
export const agent = <T>(path: string, body?: unknown) => call<T>(AGENT_SOCKET, path, body);

/**
 * First-run setup is open to whoever reaches the panel first, so it asks for
 * the code only root on the host can read (`kiwin setup-code`). Null when right.
 */
export async function checkSetupCode(code: string): Promise<string | null> {
    try {
        const r = await host<{ ok: boolean; error?: string }>("/setup/verify", { code });
        return r.ok ? null : r.error ?? "Wrong setup code";
    } catch (e) {
        return `Could not check the setup code: ${(e as Error).message}`;
    }
}

/** Encrypt a secret with the host-only key; safe to store on user.img. */
export async function sealSecret(value: string): Promise<string> {
    return (await host<{ value: string }>("/secrets/seal", { value })).value;
}

export async function unsealSecret(sealed: string): Promise<string> {
    return (await host<{ value: string }>("/secrets/unseal", { value: sealed })).value;
}

const REDIR = "/www/redir.json";

/**
 * List a sealed file in /www/redir.json under `name` (path relative to /www),
 * so the host can read it with `kiwin get <name>`. Creates the file if needed
 * and never overwrites an existing entry.
 */
export function registerSecret(name: string, file: string): void {
    let redir: Record<string, string> = {};
    if (existsSync(REDIR)) {
        try {
            redir = JSON.parse(readFileSync(REDIR, "utf8"));
        } catch {
            throw new Error(`${REDIR} is not valid JSON; fix or remove it`);
        }
    }
    if (name in redir) return;
    redir[name] = file;
    writeFileSync(`${REDIR}.tmp`, JSON.stringify(redir, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${REDIR}.tmp`, REDIR);
}

/** Decrypt a secret listed in /www/redir.json (same as `kiwin get <name>` on the host). */
export async function getSecret(name: string): Promise<string> {
    const redir = JSON.parse(readFileSync(REDIR, "utf8")) as Record<string, string>;
    if (!redir[name]) throw new Error(`"${name}" is not in ${REDIR}`);
    return unsealSecret(readFileSync(`/www/${redir[name]}`, "utf8").trim());
}
