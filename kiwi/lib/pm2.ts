import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agent } from "./host";
import { SERVICES_DIR, SOFTWARE_BIN, SOFTWARE_DIR } from "./software";

// PM2 process manager for kiwi, installed with Node.js's npm onto user.img:
//
//   /www/softwares/pm2/              npm prefix (pm2 itself)
//   /www/softwares/bin/pm2           wrapper that pins PM2_HOME, so the terminal and the panel share one daemon
//   /www/.pm2/                       PM2_HOME: dump, logs, pids
//   /www/.pm2/apps/<name>.json       ecosystem file per app, written by the panel
//   /www/services/pm2.json           isol unit that runs `pm2 resurrect` at boot

const PREFIX = join(SOFTWARE_DIR, "pm2");
const PM2_JS = join(PREFIX, "lib", "node_modules", "pm2", "bin", "pm2");
export const PM2_HOME = "/www/.pm2";
const APPS = join(PM2_HOME, "apps");
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = `${SOFTWARE_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

export interface Pm2Process {
    name: string;
    status: string;
    pid: number | null;
    cpu: number;
    memory: number;
    uptime: number | null;
    restarts: number;
    command: string;
    cwd: string;
    env: Record<string, string>;
    outLog: string | null;
    errLog: string | null;
    /** Defined by the panel (has an ecosystem file), so it can be edited here. */
    managed: boolean;
}

export interface Pm2AppInput {
    name: string;
    command: string;
    cwd: string;
    env: Record<string, string>;
}

// HOME on user.img too: npm and the apps PM2 starts must not write into the system image's /root.
const env = () => ({ ...process.env, PATH, PM2_HOME, HOME: "/www", npm_config_cache: join(SOFTWARE_DIR, ".npm-cache") });

async function exec(cmd: string[], timeoutMs = 60_000): Promise<string> {
    const p = Bun.spawn(cmd, { env: env(), cwd: "/www", stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    if (code !== 0) throw new Error((err.trim() || out.trim()).split("\n").slice(-4).join("\n") || `${cmd[0]} exited ${code}`);
    return out;
}

/** Split a command line into argv: whitespace, with '…' and "…" quoting and \ escapes. */
export function splitCommand(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let quote: string | null = null;
    let has = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote) quote = null;
            else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
            else cur += c;
        } else if (c === "'" || c === '"') {
            quote = c;
            has = true;
        } else if (c === "\\" && i + 1 < line.length) {
            cur += line[++i];
            has = true;
        } else if (/\s/.test(c)) {
            if (has || cur) out.push(cur);
            cur = "";
            has = false;
        } else cur += c;
    }
    if (quote) throw new Error("Unclosed quote in command");
    if (has || cur) out.push(cur);
    return out;
}

const quoteArg = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

export class KiwiPm2 {
    /** Node.js is installed (PM2 runs on it; apps can use any interpreter, including Bun). */
    static hasNode(): boolean {
        return existsSync(join(SOFTWARE_BIN, "node")) && existsSync(join(SOFTWARE_BIN, "npm"));
    }

    static isInstalled(): boolean {
        return existsSync(PM2_JS) && existsSync(join(SOFTWARE_BIN, "pm2"));
    }

    static version(): string | null {
        try {
            return JSON.parse(readFileSync(join(PREFIX, "lib", "node_modules", "pm2", "package.json"), "utf8")).version;
        } catch {
            return null;
        }
    }

    /** npm install -g pm2 into /www/softwares/pm2, plus wrappers and the boot unit. */
    static async install(): Promise<void> {
        if (!this.hasNode()) throw new Error("Install Node.js from Software first: PM2 runs on Node.js");
        mkdirSync(PREFIX, { recursive: true, mode: 0o755 });
        await exec([join(SOFTWARE_BIN, "npm"), "install", "--global", "--prefix", PREFIX, "--no-fund", "--no-audit", "pm2@latest"], 5 * 60_000);
        this.writeWrappers();
        mkdirSync(APPS, { recursive: true, mode: 0o700 });
        // Bring saved processes back after a reboot. Oneshot: pm2 daemonises itself.
        mkdirSync(SERVICES_DIR, { recursive: true, mode: 0o755 });
        writeFileSync(join(SERVICES_DIR, "pm2.json"), JSON.stringify({
            description: "PM2: restores saved processes at boot (installed from the PM2 page)",
            exec: [join(SOFTWARE_BIN, "pm2"), "resurrect"],
            env: { PM2_HOME, HOME: "/www", PATH },
            enabled: true,
            restart: "no",
            stopTimeout: 30,
        }, null, 2) + "\n");
        await agent("/daemon-reload", {}).catch(() => {});
    }

    private static writeWrappers() {
        mkdirSync(SOFTWARE_BIN, { recursive: true, mode: 0o755 });
        for (const cmd of ["pm2", "pm2-runtime"]) {
            const file = join(SOFTWARE_BIN, cmd);
            writeFileSync(`${file}.tmp`, `#!/bin/sh\n# Written by kiwi: one PM2 daemon for the panel and the terminal.\nexport PM2_HOME="\${PM2_HOME:-${PM2_HOME}}"\nexec ${join(PREFIX, "bin", cmd)} "$@"\n`);
            chmodSync(`${file}.tmp`, 0o755);
            renameSync(`${file}.tmp`, file);
        }
    }

    static async uninstall(): Promise<void> {
        await exec([join(SOFTWARE_BIN, "pm2"), "kill"]).catch(() => {});
        rmSync(join(SERVICES_DIR, "pm2.json"), { force: true });
        await agent("/daemon-reload", {}).catch(() => {});
        for (const cmd of ["pm2", "pm2-runtime"]) rmSync(join(SOFTWARE_BIN, cmd), { force: true });
        rmSync(PREFIX, { recursive: true, force: true });
    }

    static async list(): Promise<Pm2Process[]> {
        const raw = JSON.parse((await exec([join(SOFTWARE_BIN, "pm2"), "jlist"])).trim().split("\n").pop() || "[]") as any[];
        return raw.map((p) => {
            const e = p.pm2_env ?? {};
            const args: string[] = Array.isArray(e.args) ? e.args : typeof e.args === "string" ? [e.args] : [];
            const script = e.pm_exec_path ?? "";
            const managed = existsSync(join(APPS, `${p.name}.json`));
            let appEnv: Record<string, string> = {};
            let typed: string | null = null;
            if (managed) {
                try {
                    const eco = JSON.parse(readFileSync(join(APPS, `${p.name}.json`), "utf8"));
                    appEnv = eco.apps?.[0]?.env ?? {};
                    typed = typeof eco.kiwi?.command === "string" ? eco.kiwi.command : null;
                } catch {}
            }
            return {
                name: String(p.name),
                status: String(e.status ?? "unknown"),
                pid: p.pid || null,
                cpu: Number(p.monit?.cpu ?? 0),
                memory: Number(p.monit?.memory ?? 0),
                uptime: e.status === "online" && e.pm_uptime ? Date.now() - e.pm_uptime : null,
                restarts: Number(e.restart_time ?? 0),
                command: typed ?? [script, ...args].map(quoteArg).join(" "),
                cwd: String(e.pm_cwd ?? ""),
                env: appEnv,
                outLog: e.pm_out_log_path ?? null,
                errLog: e.pm_err_log_path ?? null,
                managed,
            };
        });
    }

    /** Create or replace an app from a command line, start it and save the process list. */
    static async save(input: Pm2AppInput, replacing?: string): Promise<void> {
        if (!NAME.test(input.name)) throw new Error("Name: letters, digits, _ . - (up to 64)");
        const argv = splitCommand(input.command.trim());
        if (argv.length === 0) throw new Error("Enter a command, e.g. node server.js or bun run start");
        const cwd = input.cwd.trim() || "/www";
        if (!cwd.startsWith("/") || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Working directory ${cwd} does not exist`);
        for (const k of Object.keys(input.env)) if (!ENV_KEY.test(k)) throw new Error(`Invalid environment variable name ${k}`);
        // Resolve bare commands (node, bun, npm) through PATH; relative scripts stay relative to cwd.
        let script = argv[0];
        // "server.js" / "app.ts" on their own run with node / bun; anything else is executed as is.
        const lang = /\.(c|m)?js$/i.test(script) ? "node" : /\.(ts|tsx)$/i.test(script) ? "bun" : null;
        let interpreter = "none";
        if (lang) {
            const found = Bun.which(lang, { PATH });
            if (!found) throw new Error(`${script} needs ${lang === "node" ? "Node.js" : "Bun"} (install it from Software)`);
            interpreter = found;
            if (!existsSync(join(cwd, script)) && !existsSync(script)) throw new Error(`${script} not found in ${cwd}`);
        } else if (!script.includes("/")) {
            const found = Bun.which(script, { PATH, cwd });
            if (!found) throw new Error(`${script} was not found (install it from Software, or give a path)`);
            script = found;
        }
        const existing = await this.list();
        if (input.name !== replacing && existing.some((p) => p.name === input.name)) throw new Error(`A process named ${input.name} already exists`);

        const file = join(APPS, `${input.name}.json`);
        mkdirSync(APPS, { recursive: true, mode: 0o700 });
        writeFileSync(file, JSON.stringify({
            // The command as typed, for editing (PM2 ignores keys besides "apps").
            kiwi: { command: input.command.trim() },
            apps: [{
                name: input.name,
                script,
                args: argv.slice(1),
                cwd,
                // Binaries and shebang scripts run as they are; .js / .ts files with node / bun.
                interpreter,
                env: input.env,
                autorestart: true,
                time: true,
            }],
        }, null, 2) + "\n", { mode: 0o600 });
        if (replacing) {
            await exec([join(SOFTWARE_BIN, "pm2"), "delete", replacing]).catch(() => {});
            if (replacing !== input.name) rmSync(join(APPS, `${replacing}.json`), { force: true });
        }
        await exec([join(SOFTWARE_BIN, "pm2"), "start", file]);
        await this.dump();
    }

    static async op(name: string, op: "start" | "stop" | "restart" | "delete"): Promise<void> {
        if (!NAME.test(name)) throw new Error("Invalid process name");
        await exec([join(SOFTWARE_BIN, "pm2"), op, name, ...(op === "restart" ? ["--update-env"] : [])]);
        if (op === "delete") rmSync(join(APPS, `${name}.json`), { force: true });
        await this.dump();
    }

    /** Last lines of a process's stdout and stderr logs. */
    static async logs(name: string, lines = 200): Promise<{ out: string; err: string }> {
        const p = (await this.list()).find((x) => x.name === name);
        if (!p) throw new Error(`No process named ${name}`);
        const tail = (file: string | null) => {
            if (!file || !file.startsWith(PM2_HOME + "/") || !existsSync(file)) return "";
            const size = statSync(file).size;
            const fd = Bun.file(file);
            // Read at most the last 256 KB.
            return fd.slice(Math.max(0, size - 256 * 1024)).text().then((t) => t.split("\n").slice(-lines - 1).join("\n"));
        };
        const [out, err] = await Promise.all([tail(p.outLog), tail(p.errLog)]);
        return { out, err };
    }

    private static async dump() {
        await exec([join(SOFTWARE_BIN, "pm2"), "save", "--force"]).catch(() => {});
    }
}
