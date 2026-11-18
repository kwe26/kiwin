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
  /**
   * Production images. When a file exists it is loop-mounted before the
   * isolation starts: `system` on `rootfs`, then `user` on `<rootfs>/www`.
   * Missing images fall back to the plain directory (development).
   */
  images: {
    system: string;
    user: string;
    /** Run `e2fsck -p` before mounting. */
    fsck: boolean;
    /** Unmount the images when the daemon stops. */
    unmountOnExit: boolean;
    /** Maximum (sparse) size an uploaded .zst is grown to when unpacked, in truncate syntax. */
    unpackSize: string;
    /** Largest user.img the isolation may request via KiwiImg.create(). */
    userMaxSize: string;
    /**
     * Scratch image for logs and other variable data, recreated empty on every
     * host boot. Each of `volatile` gets its own directory on it, bound over
     * that path inside, so the system image barely changes at runtime.
     */
    log: string;
    logSize: string;
    volatile: string[];
  };
  /** Extra host paths shared into the isolation. */
  binds: BindMount[];
  /** Paths inside the isolation that get a fresh tmpfs. */
  tmpfs: string[];
  /**
   * Package managers replaced by a stub inside the isolation (globs on the
   * rootfs; regular files only). The system image is maintained from the host.
   */
  disabledCommands: string[];
  /** Directories bound read-only inside, so package databases cannot change even with another binary. */
  readOnlyPaths: string[];
  firewall: {
    /** TCP ports the firewall never closes (host SSH, the panel); kiwin's own SSH port is added automatically. */
    protectedPorts: number[];
  };
  /**
   * Plain-HTML recovery on the panel's port, served by the daemon whenever the
   * isolation can't run or hangs. Never at the same time as the panel.
   */
  recovery: {
    host: string;
    port: number;
    /** Must exist and be active before the system starts. */
    swapFile: string;
    /** Size of a swap file created from recovery. */
    swapSize: string;
    /** CPU or memory use (percent) that counts as a hang when the panel stops answering too. */
    hangPercent: number;
    /** How long that must last. */
    hangSeconds: number;
    /** GitHub repository releases come from. */
    repo: string;
  };
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
  images: {
    system: "./images/system.img",
    user: "./images/user.img",
    fsck: true,
    unmountOnExit: true,
    unpackSize: "1T",
    userMaxSize: "1TB",
    log: "./images/log.img",
    logSize: "150MB",
    volatile: ["/tmp", "/var/tmp", "/var/log", "/var/cache"],
  },
  binds: [{ src: "/www", dest: "/mount/www" }],
  tmpfs: [],
  disabledCommands: [
    "/usr/bin/apt",
    "/usr/bin/apt-*",
    "/usr/bin/aptitude*",
    "/usr/bin/dpkg",
    "/usr/bin/dpkg-*",
    "/usr/sbin/dpkg-*",
    "/usr/bin/snap",
    "/usr/bin/snapctl",
    "/usr/lib/snapd/snapd",
    "/usr/bin/add-apt-repository",
    "/usr/bin/unattended-upgrade*",
  ],
  readOnlyPaths: ["/etc/apt", "/var/lib/apt", "/var/lib/dpkg", "/var/lib/snapd"],
  firewall: { protectedPorts: [22, 8888] },
  recovery: {
    host: "0.0.0.0",
    port: 8888,
    swapFile: "/swapfile",
    swapSize: "1536MB",
    hangPercent: 99,
    hangSeconds: 60,
    repo: "kwe26/kiwin",
  },
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
    images: { ...defaults.images, ...user.images },
    agent: { ...defaults.agent, ...user.agent },
    ssh: { ...defaults.ssh, ...user.ssh },
    firewall: { ...defaults.firewall, ...user.firewall },
    recovery: { ...defaults.recovery, ...user.recovery },
  };
  cfg.rootfs = resolve(ROOT, cfg.rootfs);
  cfg.stateDir = resolve(ROOT, cfg.stateDir);
  cfg.images.system = resolve(ROOT, cfg.images.system);
  cfg.images.user = resolve(ROOT, cfg.images.user);
  cfg.images.log = resolve(ROOT, cfg.images.log);
  cfg.binds = cfg.binds.map((b) => ({ ...b, src: resolve(ROOT, b.src) }));
  return cfg;
}

export const paths = (cfg: KiwinConfig) => ({
  daemonSock: join(cfg.stateDir, "run", "kiwin.sock"),
  ctlDir: join(cfg.stateDir, "ctl"),
  agentSock: join(cfg.stateDir, "ctl", "agent.sock"),
  hostDir: join(cfg.stateDir, "host"),
  hostSock: join(cfg.stateDir, "host", "host.sock"),
  sshDir: join(cfg.stateDir, "ssh"),
  hostKey: join(cfg.stateDir, "ssh", "ssh_host_ed25519_key"),
  /** log.img's mountpoint; its subdirectories are bound over images.volatile. */
  volatileDir: join(cfg.stateDir, "volatile"),
  /** Stub bound over images.disabledCommands. */
  disabledStub: join(cfg.stateDir, "disabled-command"),
  agentSrc: join(ROOT, "src", "agent"),
});

/** Directory on log.img for a volatile path inside: "/var/log" -> "var-log". */
export const volatileName = (inside: string) => inside.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");

/** Where the agent sees its control directory and code inside the isolation. */
export const INSIDE = {
  ctlDir: "/run/kiwin/ctl",
  agentSock: "/run/kiwin/ctl/agent.sock",
  /** Read-only: the isolation can talk to the host socket but not replace it. */
  hostDir: "/run/kiwin/host",
  hostSock: "/run/kiwin/host/host.sock",
  agentDir: "/run/kiwin/agent",
};
