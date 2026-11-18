import { existsSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KiwinConfig } from "./config";
import { isRoot } from "./sandbox";

/**
 * Host firewall for incoming connections, kept in its own nftables table
 * (`inet kiwin`) so it never touches rules made by ufw or anything else.
 * The isolation shares the host's network namespace, so this covers every
 * port a service inside listens on. Root inside has no CAP_NET_ADMIN; the
 * panel changes it through the host API.
 *
 * Safety: protected ports (SSH, the panel) are always allowed, and a change
 * that closes anything is rolled back unless confirmed within `CONFIRM_S`.
 */

export type Proto = "tcp" | "udp";

export interface FirewallRule {
  /** Single port, or first port of a range. */
  port: number;
  /** Last port of a range (inclusive). */
  to?: number;
  proto: Proto;
  comment?: string;
}

export interface FirewallState {
  enabled: boolean;
  rules: FirewallRule[];
}

export interface ListeningSocket {
  proto: Proto;
  address: string;
  port: number;
  /** "public": reachable from outside (unless the firewall blocks it); "local": loopback only. */
  scope: "public" | "local";
  process: string | null;
  pid: number | null;
  /** Running inside the isolation (vs. on the host). */
  isolated: boolean;
}

const CONFIRM_S = 60;
const MAX_RULES = 256;
const TABLE = "kiwin";

const run = (cmd: string[], stdin?: string) => {
  const p = Bun.spawnSync(cmd, { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};

const covers = (r: FirewallRule, proto: Proto, port: number) => r.proto === proto && port >= r.port && port <= (r.to ?? r.port);

export function validateRules(raw: unknown): FirewallRule[] {
  if (!Array.isArray(raw)) throw new Error("rules must be a list");
  if (raw.length > MAX_RULES) throw new Error(`at most ${MAX_RULES} rules`);
  return raw.map((r: any, i) => {
    const port = Number(r?.port);
    const to = r?.to === undefined || r?.to === null || r?.to === "" ? undefined : Number(r.to);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`rule ${i + 1}: invalid port`);
    if (to !== undefined && (!Number.isInteger(to) || to <= port || to > 65535)) throw new Error(`rule ${i + 1}: invalid port range`);
    if (r?.proto !== "tcp" && r?.proto !== "udp") throw new Error(`rule ${i + 1}: protocol must be tcp or udp`);
    const comment = typeof r?.comment === "string" ? r.comment.slice(0, 80) : undefined;
    return { port, ...(to !== undefined ? { to } : {}), proto: r.proto, ...(comment ? { comment } : {}) };
  });
}

/** nft ruleset for a state. Only numbers from validated rules go into it. */
function ruleset(state: FirewallState, protectedPorts: number[]): string {
  // nft refuses overlapping elements in one set, so merge into disjoint ranges.
  const ports = (proto: Proto) => {
    const ranges: [number, number][] = proto === "tcp" ? protectedPorts.map((p) => [p, p]) : [];
    for (const r of state.rules) if (r.proto === proto) ranges.push([r.port, r.to ?? r.port]);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of ranges) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    return merged.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`));
  };
  const tcp = ports("tcp");
  const udp = ports("udp");
  return [
    // Declaring then deleting makes the delete safe when the table does not exist yet.
    `table inet ${TABLE}`,
    `delete table inet ${TABLE}`,
    `table inet ${TABLE} {`,
    `  chain input {`,
    `    type filter hook input priority filter; policy drop;`,
    `    ct state established,related accept`,
    `    ct state invalid drop`,
    `    iifname "lo" accept`,
    `    meta l4proto { icmp, ipv6-icmp } accept`,
    `    udp sport 67 udp dport 68 accept`,
    `    udp sport 547 udp dport 546 accept`,
    ...(tcp.length ? [`    tcp dport { ${tcp.join(", ")} } accept`] : []),
    ...(udp.length ? [`    udp dport { ${udp.join(", ")} } accept`] : []),
    `  }`,
    `}`,
    "",
  ].join("\n");
}

export class Firewall {
  private file: string;
  private state: FirewallState = { enabled: false, rules: [] };
  /** Applied but not yet confirmed; `previous` is restored when the timer fires. */
  private pending: { previous: FirewallState; revertAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  lastError: string | null = null;

  constructor(private cfg: KiwinConfig, private log: (l: string) => void, private initPid: () => number | null) {
    this.file = join(cfg.stateDir, "firewall.json");
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      this.state = { enabled: !!saved.enabled, rules: validateRules(saved.rules ?? []) };
    } catch {}
  }

  get available(): boolean {
    return isRoot() && Bun.which("nft") !== null;
  }

  /** Ports that stay open whatever the rules say: SSH to the host and isolation, and the panel. */
  protectedPorts(): number[] {
    const ports = new Set(this.cfg.firewall.protectedPorts);
    if (this.cfg.ssh.enabled) ports.add(this.cfg.ssh.port);
    return [...ports].sort((a, b) => a - b);
  }

  /** Apply the saved state (daemon start). */
  restore() {
    if (!this.state.enabled) return;
    if (!this.available) {
      this.log("firewall: enabled in firewall.json but nft is unavailable (not root, or nftables missing)");
      return;
    }
    const err = this.apply(this.state);
    this.log(err ? `firewall: could not apply saved rules: ${err}` : `firewall: enabled (${this.state.rules.length} rules)`);
  }

  info() {
    return {
      available: this.available,
      enabled: this.state.enabled,
      rules: this.state.rules,
      protectedPorts: this.protectedPorts(),
      pending: this.pending ? { revertAt: this.pending.revertAt, previous: this.pending.previous } : null,
      ufwActive: this.ufwActive(),
      lastError: this.lastError,
      listening: listeningSockets(this.initPid()),
    };
  }

  /**
   * Apply a new state right away. If it allows less than before (enabling,
   * or a port no longer allowed), it must be confirmed or it is rolled back.
   */
  update(next: FirewallState): { ok: true; needsConfirm: boolean } | { ok: false; error: string } {
    if (!this.available) return { ok: false, error: "the firewall needs kiwin running as root with nftables (nft) installed" };
    const previous = this.pending?.previous ?? this.state;
    const err = this.apply(next);
    if (err) return { ok: false, error: err };
    const stillOpen = (r: FirewallRule) => {
      for (let p = r.port; p <= (r.to ?? r.port); p++) if (!next.rules.some((n) => covers(n, r.proto, p))) return false;
      return true;
    };
    const closes = next.enabled && (!previous.enabled || !previous.rules.every(stillOpen));
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.state = next;
    if (closes) {
      const revertAt = Date.now() + CONFIRM_S * 1000;
      const timer = setTimeout(() => {
        this.log("firewall: change not confirmed, rolling back");
        this.revert();
      }, CONFIRM_S * 1000);
      this.pending = { previous, revertAt, timer };
      this.log(`firewall: applied, waiting ${CONFIRM_S}s for confirmation`);
    } else this.save();
    return { ok: true, needsConfirm: closes };
  }

  confirm(): boolean {
    if (!this.pending) return false;
    clearTimeout(this.pending.timer);
    this.pending = null;
    this.save();
    this.log(`firewall: confirmed (${this.state.enabled ? `enabled, ${this.state.rules.length} rules` : "disabled"})`);
    return true;
  }

  revert(): boolean {
    if (!this.pending) return false;
    clearTimeout(this.pending.timer);
    const previous = this.pending.previous;
    this.pending = null;
    const err = this.apply(previous);
    if (err) this.log(`firewall: rollback failed: ${err}`);
    this.state = previous;
    return true;
  }

  private apply(state: FirewallState): string | null {
    const r = state.enabled
      ? run(["nft", "-f", "-"], ruleset(state, this.protectedPorts()))
      : run(["nft", "-f", "-"], `table inet ${TABLE}\ndelete table inet ${TABLE}\n`);
    this.lastError = r.code === 0 ? null : r.err || `nft exited ${r.code}`;
    return this.lastError;
  }

  private save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  private ufwActive(): boolean {
    if (!isRoot() || !Bun.which("ufw")) return false;
    return /^Status: active/m.test(run(["ufw", "status"]).out);
  }
}

// ---- Listening sockets (/proc/net) ---------------------------------------

function parseAddress(hex: string, v6: boolean): string {
  if (!v6) {
    const n = parseInt(hex, 16);
    return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join(".");
  }
  // Four little-endian 32-bit words.
  const bytes: number[] = [];
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (let b = 3; b >= 0; b--) bytes.push(parseInt(word.slice(b * 2, b * 2 + 2), 16));
  }
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) return bytes.slice(12).join("."); // ::ffff:a.b.c.d
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  // RFC 5952: the longest run of two or more zero groups becomes "::".
  let best = -1, bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > bestLen) [best, bestLen] = [i, j - i];
    i = j;
  }
  if (best < 0) return groups.join(":");
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + bestLen).join(":")}`;
}

/** socket inode -> pid, by walking /proc/<pid>/fd (needs root for other users' processes). */
function socketOwners(): Map<string, number> {
  const owners = new Map<string, number>();
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m && !owners.has(m[1])) owners.set(m[1], Number(pid));
      } catch {}
    }
  }
  return owners;
}

export function listeningSockets(isolationInit: number | null): ListeningSocket[] {
  const owners = socketOwners();
  let isolationNs: string | null = null;
  try {
    if (isolationInit) isolationNs = readlinkSync(`/proc/${isolationInit}/ns/pid`);
  } catch {}
  const seen = new Set<string>();
  const out: ListeningSocket[] = [];
  for (const [file, proto, v6] of [["tcp", "tcp", false], ["tcp6", "tcp", true], ["udp", "udp", false], ["udp6", "udp", true]] as const) {
    const path = `/proc/net/${file}`;
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      // tcp: 0A = LISTEN. udp: 07 = unconnected (bound, receiving).
      if (f[3] !== (proto === "tcp" ? "0A" : "07")) continue;
      const [addrHex, portHex] = f[1].split(":");
      const address = parseAddress(addrHex, v6);
      const port = parseInt(portHex, 16);
      if (!port) continue;
      const pid = owners.get(f[9]) ?? null;
      let processName: string | null = null;
      let isolated = false;
      if (pid) {
        try {
          processName = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        } catch {}
        try {
          isolated = isolationNs !== null && readlinkSync(`/proc/${pid}/ns/pid`) === isolationNs;
        } catch {}
      }
      const local = address.startsWith("127.") || address === "::1";
      const key = `${proto}/${address}/${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ proto, address, port, scope: local ? "local" : "public", process: processName, pid, isolated });
    }
  }
  return out.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto) || a.address.localeCompare(b.address));
}
