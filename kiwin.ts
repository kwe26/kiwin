#!/usr/bin/env bun
import { loadConfig, paths } from "./src/config";
import { enterCommand, lookupAccount } from "./src/sandbox";

const USAGE = `kiwin - isolated system manager

Usage:
  kiwin daemon                     Run the host daemon (used by systemd)
  kiwin status                     Isolation + unit overview
  kiwin list                       List units
  kiwin start|stop|restart|reload <unit>
  kiwin enable|disable <unit>      Toggle autostart (edits /etc/isol/<unit>.json)
  kiwin show <unit>                Unit details as JSON
  kiwin logs <unit> [-n N] [-f]    Show unit logs
  kiwin daemon-reload              Re-read /etc/isol/*.json
  kiwin ps                         Processes inside the isolation
  kiwin kill <pid> [SIGNAL]        Signal a process inside the isolation
  kiwin shell [user]               Interactive shell inside the isolation
  kiwin exec [-u user] -- <cmd>    Run a command inside the isolation
  kiwin isolation-restart          Tear down and relaunch the whole isolation
  kiwin recovery                   Print a one-time sign-in link for /recovery (it must be running)
  kiwin recovery enter             Pause the system and open /recovery
  kiwin setup-code                 The code the panel asks for on first-run setup
  kiwin get <name>                 Decrypt a secret listed in /www/redir.json (e.g. mysql_password)
  kiwin secret-key export          Print the key that seals /www/password.txt (keep it with user.img backups)
  kiwin secret-key import <key>    Install that key on a new server before moving user.img there
`;

const cfg = loadConfig();
const sock = paths(cfg).daemonSock;

async function api(path: string, method = "GET", body?: unknown) {
  let res: Response;
  try {
    res = await fetch(`http://kiwin${path}`, {
      method,
      unix: sock,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
    } as RequestInit);
  } catch (e) {
    die(`cannot reach kiwin daemon at ${sock} (${(e as Error).message}). Is it running, and are you root?`);
  }
  return res;
}

async function apiJson(path: string, method = "GET", body?: unknown) {
  const res = await api(path, method, body);
  const data = await res.json();
  if (!res.ok) die(data.error ?? `HTTP ${res.status}`);
  return data;
}

function die(msg: string): never {
  console.error(`kiwin: ${msg}`);
  process.exit(1);
}

const fmtUptime = (s: number | null) =>
  s === null ? "-" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;

function table(rows: string[][]) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  "));
}

async function printUnits() {
  const units = await apiJson("/isol/units");
  if (!units.length) return console.log("no units in /etc/isol");
  table([
    ["UNIT", "STATE", "ENABLED", "PID", "UPTIME", "RESTARTS", "DESCRIPTION"],
    ...units.map((u: any) => [
      u.name,
      u.state + (u.stale ? "*" : ""),
      u.enabled ? "yes" : "no",
      String(u.pid ?? "-"),
      fmtUptime(u.uptime),
      String(u.restarts),
      u.error ? `${u.description} (${u.error})` : u.description,
    ]),
  ]);
}

async function enter(user: string, command?: string, tty = false) {
  const status = await apiJson("/status");
  const initPid = status.isolation.initPid;
  if (!initPid) die("isolation is not running");
  const account = lookupAccount(cfg, user) ?? die(`no such user in isolation: ${user}`);
  const argv = enterCommand(cfg, initPid, account, { command, term: tty ? process.env.TERM ?? "xterm" : undefined });
  const p = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await p.exited);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "daemon": {
    const { runDaemon } = await import("./src/daemon");
    
    await runDaemon();
    break;
  }
  case "status": {
    const s = await apiJson("/status");
    const i = s.isolation;
    console.log(`isolation: ${i.running ? "running" : "stopped"}${s.rootless ? " (rootless dev mode)" : ""}`);
    console.log(`  rootfs:   ${s.rootfs}`);
    console.log(`  pids:     bwrap ${i.bwrapPid ?? "-"}, init ${i.initPid ?? "-"}, agent ${i.agent ? "up" : "down"}`);
    console.log(`  since:    ${i.startedAt ? new Date(i.startedAt).toISOString() : "-"} (launches: ${i.launches})`);
    console.log(`  ssh:      ${s.ssh ? `${s.ssh.host}:${s.ssh.port}` : "disabled"}`);
    console.log();
    if (i.agent) await printUnits();
    break;
  }
  case "list":
    await printUnits();
    break;
  case "start":
  case "stop":
  case "restart":
  case "reload":
  case "enable":
  case "disable": {
    if (!args.length) die(`usage: kiwin ${cmd} <unit>...`);
    for (const u of args) {
      const res = await api(`/isol/units/${encodeURIComponent(u)}/${cmd}`, "POST");
      const data = await res.json();
      if (!res.ok) die(`${u}: ${data.error}`);
      console.log(`${u}: ${data.state}${data.enabled ? "" : " (disabled)"}`);
    }
    break;
  }
  case "show":
    console.log(JSON.stringify(await apiJson(`/isol/units/${encodeURIComponent(args[0] ?? "")}`), null, 2));
    break;
  case "logs": {
    const unit = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-n") ?? die("usage: kiwin logs <unit> [-n N] [-f]");
    const n = args.includes("-n") ? args[args.indexOf("-n") + 1] : "100";
    const follow = args.includes("-f") ? "&follow=1" : "";
    const res = await api(`/isol/units/${encodeURIComponent(unit)}/logs?lines=${n}${follow}`);
    if (!res.ok) die((await res.json()).error);
    for await (const chunk of res.body!) process.stdout.write(chunk);
    break;
  }
  case "daemon-reload": {
    const r = await apiJson("/isol/daemon-reload", "POST");
    console.log(`added: ${r.added.join(", ") || "-"}; removed: ${r.removed.join(", ") || "-"}; changed: ${r.changed.join(", ") || "-"}`);
    if (r.changed.length) console.log("changed units take effect on their next restart");
    break;
  }
  case "ps": {
    const procs = await apiJson("/isol/ps");
    table([
      ["PID", "PPID", "UID", "RSS", "UNIT", "COMMAND"],
      ...procs.map((p: any) => [String(p.pid), String(p.ppid), String(p.uid), `${Math.round(p.rssKb / 1024)}M`, p.unit ?? "-", p.cmd]),
    ]);
    break;
  }
  case "kill": {
    const pid = Number(args[0]);
    await apiJson("/isol/kill", "POST", { pid, signal: args[1] ?? "SIGTERM" });
    break;
  }
  case "shell":
    await enter(args[0] ?? "root", undefined, true);
    break;
  case "exec": {
    let user = "root";
    const dash = args.indexOf("--");
    const opts = dash >= 0 ? args.slice(0, dash) : [];
    const rest = dash >= 0 ? args.slice(dash + 1) : args;
    if (opts[0] === "-u") user = opts[1];
    if (!rest.length) die("usage: kiwin exec [-u user] -- <command...>");
    const quoted = rest.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
    await enter(user, quoted);
    break;
  }
  case "setup-code":
    console.log((await apiJson("/setup/code")).code);
    break;
  case "get": {
    if (!args[0]) die("usage: kiwin get <name>   (names come from /www/redir.json)");
    // Through the daemon: user.img (and so /www) is only mounted while it runs.
    console.log((await apiJson(`/secrets/get/${encodeURIComponent(args[0])}`)).value);
    break;
  }
  case "secret-key": {
    const { exportKey, importKey } = await import("./src/secrets");
    if (args[0] === "export") console.log(exportKey(cfg));
    else if (args[0] === "import" && args[1]) {
      importKey(cfg, args[1]);
      console.log("key installed");
    } else die("usage: kiwin secret-key export | import <base64-key>");
    break;
  }
  case "recovery": {
    if (args[0] === "enter") await apiJson("/recovery/enter", "POST");
    else if (args[0]) die(USAGE);
    const { token, port } = await apiJson("/recovery/link", "POST");
    console.log(`http://<this server>:${port}/recovery?t=${token}`);
    console.log("Works once, for 10 minutes. It signs in with full access, so keep it private.");
    break;
  }
  case "isolation-restart":
    console.log(await apiJson("/isolation/restart", "POST"));
    break;
  case undefined:
  case "help":
  case "-h":
  case "--help":
    console.log(USAGE);
    break;
  default:
    die(`unknown command ${cmd}\n\n${USAGE}`);
}
