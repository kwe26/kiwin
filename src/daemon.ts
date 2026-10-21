import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, loadConfig, paths } from "./config";
import { Sandbox, agentFetch, isRoot } from "./sandbox";
import { startSsh } from "./ssh";

export async function runDaemon() {
  const cfg = loadConfig();
  const p = paths(cfg);
  const log = (l: string) => console.log(`${new Date().toISOString()} ${l}`);

  if (!existsSync(join(cfg.rootfs, "usr", "bin"))) throw new Error(`rootfs ${cfg.rootfs} does not look like a system`);
  for (const d of [dirname(p.daemonSock), p.ctlDir, p.sshDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  if (isRoot()) {
    // State holds the control socket and ssh host key: it must not stay
    // writable by whoever created it before the daemon first ran as root.
    for (const d of [cfg.stateDir, dirname(p.daemonSock), p.ctlDir, p.sshDir]) {
      chownSync(d, 0, 0);
      chmodSync(d, 0o700);
    }
    for (const f of readdirSync(p.sshDir)) chownSync(join(p.sshDir, f), 0, 0);
  }
  if (!isRoot()) log("warning: not running as root, using an unprivileged user namespace (dev mode)");
  log(`config: ${configPath()}`);

  const sandbox = new Sandbox(cfg, log);
  await sandbox.start();

  const ssh = cfg.ssh.enabled ? startSsh(cfg, sandbox, log) : null;

  // ---- Control API (HTTP over unix socket, root only) ----
  rmSync(p.daemonSock, { force: true });
  const server = Bun.serve({
    unix: p.daemonSock,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/status") {
        const agent = await agentFetch(cfg, "/health", {}, 2000)
          .then((r) => r.json())
          .catch(() => null);
        return Response.json({
          isolation: {
            running: sandbox.running,
            bwrapPid: sandbox.proc?.pid ?? null,
            initPid: sandbox.initPid,
            startedAt: sandbox.startedAt,
            launches: sandbox.launches,
            lastExit: sandbox.lastExit,
            agent,
          },
          rootfs: cfg.rootfs,
          rootless: !isRoot(),
          ssh: cfg.ssh.enabled ? { host: cfg.ssh.host, port: cfg.ssh.port } : null,
        });
      }
      if (url.pathname === "/isolation/restart" && req.method === "POST") {
        await sandbox.stop();
        await sandbox.start();
        return Response.json({ ok: true, initPid: sandbox.initPid });
      }
      // Everything under /isol/* is forwarded to the agent inside the isolation.
      if (url.pathname.startsWith("/isol/")) {
        try {
          const res = await agentFetch(
            cfg,
            url.pathname.slice(5) + url.search,
            { method: req.method, body: req.body, headers: req.headers },
            url.searchParams.get("follow") === "1" ? 0 : 120_000,
          );
          return new Response(res.body, { status: res.status, headers: res.headers });
        } catch (e) {
          return Response.json({ error: `isolation agent unreachable: ${(e as Error).message}` }, { status: 503 });
        }
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  chmodSync(p.daemonSock, 0o600);
  log(`control socket: ${p.daemonSock}`);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} received, stopping isolation`);
    ssh?.close();
    await sandbox.stop();
    server.stop(true);
    rmSync(p.daemonSock, { force: true });
    log("bye");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
