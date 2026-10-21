import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");

export interface BindMount {
  src: string;
  dest: string;
  ro?: boolean;
}

export interface KiwinConfig {
  /** Root filesystem of the isolation (debootstrap output). */
  rootfs: string;
  hostname: string;
  /** Host-side state: control sockets, ssh host key. */
  stateDir: string;
  /** Extra host paths shared into the isolation. */
  binds: BindMount[];
  /** Paths inside the isolation that get a fresh tmpfs. */
  tmpfs: string[];
  /** Capabilities removed from everything running inside (only applies when kiwin runs as root). */
  dropCaps: string[];
  /** Seconds to wait before relaunching a crashed isolation. */
  restartDelay: number;
  agent: {
    /** Bun binary inside the isolation. */
    bun: string;
    /** Unit definition directory inside the isolation. */
    unitsDir: string;
    /** Unit log directory inside the isolation. */
    logDir: string;
  };
  ssh: {
    enabled: boolean;
    host: string;
    port: number;
    /** Restrict logins to these isolation users (empty = any user with authorized keys). */
    allowUsers: string[];
    /** Extra host-side authorized_keys files per isolation user, e.g. { "root": "/root/.ssh/authorized_keys" }. */
    authorizedKeys: Record<string, string>;
    banner?: string;
  };
}

const defaults: KiwinConfig = {
  rootfs: "./system",
  hostname: "kiwin",
  stateDir: "./state",
  binds: [{ src: "/www", dest: "/mount/www" }],
  tmpfs: [],
  dropCaps: [
    "CAP_SYS_ADMIN",
    "CAP_SYS_MODULE",
    "CAP_SYS_RAWIO",
    "CAP_SYS_BOOT",
    "CAP_SYS_TIME",
    "CAP_SYS_PTRACE",
    "CAP_SYSLOG",
    "CAP_NET_ADMIN",
    "CAP_MKNOD",
    "CAP_MAC_ADMIN",
    "CAP_MAC_OVERRIDE",
    "CAP_AUDIT_CONTROL",
    "CAP_BPF",
    "CAP_PERFMON",
    "CAP_WAKE_ALARM",
    "CAP_BLOCK_SUSPEND",
    "CAP_LINUX_IMMUTABLE",
  ],
  restartDelay: 3,
  agent: {
    bun: "/usr/bin/bun",
    unitsDir: "/etc/isol",
    logDir: "/var/log/isol",
  },
  ssh: {
    enabled: true,
    host: "0.0.0.0",
    port: 2222,
    allowUsers: [],
    authorizedKeys: {},
  },
};

export function configPath(): string {
  return resolve(process.env.KIWIN_CONFIG ?? join(ROOT, "kiwin.json"));
}

export function loadConfig(): KiwinConfig {
  const path = configPath();
  const user: Partial<KiwinConfig> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const cfg: KiwinConfig = {
    ...defaults,
    ...user,
    agent: { ...defaults.agent, ...user.agent },
    ssh: { ...defaults.ssh, ...user.ssh },
  };
  cfg.rootfs = resolve(ROOT, cfg.rootfs);
  cfg.stateDir = resolve(ROOT, cfg.stateDir);
  cfg.binds = cfg.binds.map((b) => ({ ...b, src: resolve(ROOT, b.src) }));
  return cfg;
}

export const paths = (cfg: KiwinConfig) => ({
  daemonSock: join(cfg.stateDir, "run", "kiwin.sock"),
  ctlDir: join(cfg.stateDir, "ctl"),
  agentSock: join(cfg.stateDir, "ctl", "agent.sock"),
  sshDir: join(cfg.stateDir, "ssh"),
  hostKey: join(cfg.stateDir, "ssh", "ssh_host_ed25519_key"),
  agentSrc: join(ROOT, "src", "agent"),
});

/** Where the agent sees its control directory and code inside the isolation. */
export const INSIDE = {
  ctlDir: "/run/kiwin/ctl",
  agentSock: "/run/kiwin/ctl/agent.sock",
  agentDir: "/run/kiwin/agent",
};
