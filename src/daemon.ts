import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, loadConfig, paths } from "./config";
import { Sandbox, agentFetch, isRoot } from "./sandbox";
import { startSsh } from "./ssh";
import { Images } from "./images";
import { getSecret, seal, unseal } from "./secrets";
import { Firewall, validateRules } from "./firewall";
import { Recovery, verifyRootPassword, type RecoveryReason } from "./recovery";
import { Updates } from "./updates";
import { SetupCode } from "./setup-code";
import { Watchdog, killListeners, pauseIsolation, resumeIsolation } from "./watchdog";

/** The isol unit that runs the panel (defaults/etc/isol/kiwin.json). */
const PANEL_UNIT = "kiwin";

/** A Force Resume gets this long before the watchdog may step in again. */
const RESUME_GRACE_MS = 10 * 60_000;
/** An upgrade the user walked away from: the system comes back by itself. */
const UPGRADE_WAIT_MS = 10 * 60_000;

export async function runDaemon() {
  const cfg = loadConfig();
  const p = paths(cfg);
  const log = (l: string) => console.log(`${new Date().toISOString()} ${l}`);
  const daemonStartedAt = Date.now();

  const images = new Images(cfg, log);
  const stateDirs = [dirname(p.daemonSock), p.ctlDir, p.hostDir, p.sshDir];
  for (const d of stateDirs) mkdirSync(d, { recursive: true, mode: 0o700 });
  if (isRoot()) {
    // State holds the control socket and ssh host key: it must not stay
    // writable by whoever created it before the daemon first ran as root.
    for (const d of [cfg.stateDir, ...stateDirs]) {
      chownSync(d, 0, 0);
      chmodSync(d, 0o700);
    }
    for (const f of readdirSync(p.sshDir)) chownSync(join(p.sshDir, f), 0, 0);
  }
  if (!isRoot()) log("warning: not running as root, using an unprivileged user namespace (dev mode)");
  log(`config: ${configPath()}`);

  const sandbox = new Sandbox(cfg, log);
  const updates = new Updates(cfg, log);
  const setupCode = new SetupCode(cfg);
  if (isRoot()) setupCode.get();
  let paused = false;
  let swapState = { ok: true, detail: "not checked" };

  /** Start the system, or say why it can't: the swap file is mandatory, and the images must mount. */
  const boot = async (): Promise<RecoveryReason | null> => {
    try {
      images.mountAll();
      if (!existsSync(join(cfg.rootfs, "usr", "bin"))) {
        images.unmountAll();
        throw new Error(`rootfs ${cfg.rootfs} does not look like a system`);
      }
    } catch (e) {
      if (!isRoot()) throw e;
      return { code: "system", title: "system.img can't be used", detail: (e as Error).message };
    }
    swapState = isRoot() ? images.ensureSwap() : { ok: true, detail: "not required in development" };
    if (!swapState.ok) {
      return {
        code: "swap",
        title: "A swap file is required",
        detail: `${swapState.detail}. Kiwin won't start the system without one: create it below.`,
      };
    }
    sandbox.extras.volatileDir = images.volatileDir();
    if (sandbox.extras.volatileDir) log(`volatile data (${cfg.images.volatile.join(", ")}) on log.img, wiped on reboot`);
    await sandbox.start();
    return null;
  };

  /** Stop the isolation whatever state it is in. */
  const stopIsolation = async (timeoutMs?: number) => {
    if (paused && sandbox.initPid) resumeIsolation(sandbox.initPid);
    paused = false;
    await sandbox.stop(timeoutMs);
  };

  /** Start or stop only the panel; the agent may still be coming up after a start. */
  const panelUnit = async (op: "start" | "stop") => {
    for (let i = 0; i < 20; i++) {
      try {
        const res = await agentFetch(cfg, `/units/${PANEL_UNIT}/${op}`, { method: "POST" }, 30_000);
        if (!res.ok) log(`recovery: panel ${op}: ${await res.text()}`);
        return;
      } catch {
        await Bun.sleep(500);
      }
    }
    log(`recovery: panel ${op}: the isolation agent did not answer`);
  };

  /** Recovery needs the panel's port while the system keeps running. */
  const releasePort = async () => {
    await panelUnit("stop");
    if (sandbox.initPid) killListeners(sandbox.initPid, cfg.recovery.port);
  };

  const restart = async () => {
    await stopIsolation(5000);
    const reason = await boot();
    if (reason) await recovery.open(reason);
  };

  const recovery = new Recovery(cfg, log, {
    status: () => {
      if (isRoot()) swapState = images.ensureSwap();
      return { isolation: paused ? "paused" : sandbox.running ? "running" : "stopped", swap: swapState, user: images.userInfo() };
    },
    restart,
    resume: async () => {
      if (!paused || !sandbox.initPid) return;
      watchdog.snooze(RESUME_GRACE_MS);
      resumeIsolation(sandbox.initPid);
      paused = false;
      // The panel was killed by the pause; it waits for Continue.
      await releasePort();
      log("recovery: system resumed");
    },
    pause: async () => {
      if (paused || !sandbox.running || !sandbox.initPid) return;
      pauseIsolation(sandbox.initPid, cfg.recovery.port);
      paused = true;
      log("recovery: system paused");
    },
    stop: async () => {
      await stopIsolation(5000);
      log("recovery: system stopped");
    },
    start: async () => {
      if (sandbox.running) return;
      if (images.exporting) throw new Error("user.img is being downloaded; start the system when that has finished");
      const reason = await boot();
      if (reason) throw new Error(reason.detail);
      await releasePort();
      log("recovery: system started without the panel");
    },
    continueNormal: async () => {
      if (paused && sandbox.initPid) {
        resumeIsolation(sandbox.initPid);
        paused = false;
      }
      watchdog.snooze(RESUME_GRACE_MS);
      await panelUnit("start");
      log("recovery: back to the normal interface");
    },
    createSwap: (out) => images.createSwap(out),
    resizeUser: async (size, force, out) => {
      if (images.exporting) throw new Error("user.img is being downloaded; resize it when that has finished");
      out("Stopping the system");
      await stopIsolation(5000);
      await images.resizeUser(size * 1024 ** 3, out, force);
    },
    checkUpdates: (force) => updates.check(force),
    upgrade: (out, progress) => updates.upgrade(out, progress),
    rollback: async (out) => updates.rollback(out),
    downloadUser: () => {
      if (sandbox.running || paused) throw new Error("Stop the system first: user.img must not change while it is copied");
      return images.exportUser();
    },
    power: (kind) => {
      log(`recovery: ${kind} requested from recovery`);
      // After the answer has gone out; systemd stops kiwin (and the system) cleanly first.
      setTimeout(() => {
        const cmd = Bun.which("systemctl") ? ["systemctl", kind] : [kind];
        const r = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "pipe" });
        if (r.exitCode !== 0) log(`recovery: ${cmd.join(" ")} failed: ${r.stderr.toString().trim()}`);
      }, 1000);
    },
    verifyPassword: verifyRootPassword,
  });

  /** Freeze a hung isolation, or just take over the port when it isn't running. */
  const pauseAndRecover = async (reason: RecoveryReason) => {
    if (recovery.active) return;
    if (sandbox.initPid && sandbox.running) {
      pauseIsolation(sandbox.initPid, cfg.recovery.port);
      paused = true;
    }
    await recovery.open(reason);
  };

  /** Shut the system down for an upgrade; the panel has its one-time link by now. */
  const enterUpgrade = async () => {
    await stopIsolation();
    await recovery.open({
      code: "upgrade",
      title: "Kiwin is shut down for an upgrade",
      detail: "The system has been stopped. Start the upgrade below, or cancel to start the system again.",
    });
    setTimeout(() => {
      if (recovery.code === "upgrade" && !recovery.jobRunning) void recovery.close().then(restart);
    }, UPGRADE_WAIT_MS);
  };

  const watchdog = new Watchdog(
    cfg,
    sandbox,
    () => isRoot() && !recovery.active,
    (detail) => void pauseAndRecover({ code: "hang", title: "The system stopped responding, so it was paused", detail }),
    (detail) => void (async () => {
      await stopIsolation(5000);
      await recovery.open({ code: "crash", title: "The system keeps crashing", detail });
    })(),
  );

  const reason = await boot();
  if (reason) await recovery.open(reason);
  watchdog.start();

  const ssh = cfg.ssh.enabled ? startSsh(cfg, sandbox, log) : null;

  const firewall = new Firewall(cfg, log, () => sandbox.initPid);
  firewall.restore();

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
          recovery: recovery.active ? recovery.code : null,
        });
      }
      // First-run setup of the panel asks for this (see setup-code.ts).
      if (url.pathname === "/setup/code" && req.method === "GET") return Response.json({ code: setupCode.get() });
      // Root on the host: a full sign-in link for when root has no password,
      // or to get to recovery on purpose.
      if (url.pathname === "/recovery/enter" && req.method === "POST") {
        await pauseAndRecover({ code: "manual", title: "Opened by root", detail: "Root opened recovery from the command line, so the system was paused." });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/recovery/link" && req.method === "POST") {
        if (!recovery.active) return Response.json({ error: "recovery is not running; `kiwin recovery enter` pauses the system and opens it" }, { status: 409 });
        return Response.json({ token: recovery.mint("full"), port: cfg.recovery.port });
      }
      // `kiwin get <name>`: decrypt a secret listed in /www/redir.json on the
      // mounted user.img. Only on this root-only socket, never the host API.
      if (url.pathname.startsWith("/secrets/get/") && req.method === "GET") {
        try {
          return Response.json({ value: getSecret(cfg, decodeURIComponent(url.pathname.slice("/secrets/get/".length))) });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 404 });
        }
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

  // ---- Host API for the isolation (KiwiImg) ----
  // Bound read-only into the isolation at /run/kiwin/host/host.sock. Keep it
  // narrow: everything here runs as host root on behalf of the isolation.
  rmSync(p.hostSock, { force: true });
  const hostApi = Bun.serve({
    unix: p.hostSock,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/isolation" && req.method === "GET") {
        // Read-only status for the panel's dashboard.
        return Response.json({
          running: sandbox.running,
          startedAt: sandbox.startedAt,
          launches: sandbox.launches,
          lastExit: sandbox.lastExit,
          rootless: !isRoot(),
          hostname: cfg.hostname,
          daemonStartedAt,
          images: {
            system: existsSync(cfg.images.system),
            user: images.userInfo().mounted,
            log: images.volatileDir() !== null,
          },
          ssh: cfg.ssh.enabled ? { port: cfg.ssh.port } : null,
          bwrap: isRoot() ? "private copy (AppArmor-free)" : "system (rootless)",
        });
      }
      if (url.pathname === "/images/user" && req.method === "GET") return Response.json(images.userInfo());
      // Updates. The panel can't name a release: the daemon picks the latest itself.
      if (url.pathname === "/updates" && req.method === "GET") return Response.json(await updates.check());
      if (url.pathname === "/updates/check" && req.method === "POST") return Response.json(await updates.check(true));
      // The token only signs in to the upgrade page: root inside can reach this
      // API, and must not get what the host root password protects.
      // Recovery with the system left running: only the panel stops. Signing in
      // still takes the host root password.
      if (url.pathname === "/recovery/open" && req.method === "POST") {
        setTimeout(() => void (async () => {
          if (recovery.active) return;
          await releasePort();
          await recovery.open({ code: "maintenance", title: "Opened from the panel", detail: "The panel is stopped. The system keeps running in the background." });
        })(), 500);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/updates/enter" && req.method === "POST") {
        const token = recovery.mint("upgrade");
        setTimeout(() => void enterUpgrade(), 500);
        return Response.json({ token });
      }
      // Firewall: input rules only, in kiwin's own nftables table (see firewall.ts).
      if (url.pathname === "/firewall" && req.method === "GET") return Response.json(firewall.info());
      if (url.pathname === "/firewall" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { enabled?: unknown; rules?: unknown };
        let rules;
        try {
          rules = validateRules(body.rules);
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
        }
        const result = firewall.update({ enabled: body.enabled === true, rules });
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
      if (url.pathname === "/firewall/confirm" && req.method === "POST") return Response.json({ ok: firewall.confirm() });
      if (url.pathname === "/firewall/revert" && req.method === "POST") return Response.json({ ok: firewall.revert() });
      if (url.pathname === "/setup/verify" && req.method === "POST") {
        const { code } = (await req.json().catch(() => ({}))) as { code?: unknown };
        return Response.json(setupCode.verify(code));
      }
      if (url.pathname === "/images/user" && req.method === "POST") {
        const { size, force } = (await req.json().catch(() => ({}))) as { size?: unknown; force?: unknown };
        const result = images.createUser(String(size ?? ""), force === true);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
      if ((url.pathname === "/secrets/seal" || url.pathname === "/secrets/unseal") && req.method === "POST") {
        const { value } = (await req.json().catch(() => ({}))) as { value?: unknown };
        if (typeof value !== "string" || value.length > 64 * 1024) return Response.json({ error: "value must be a string" }, { status: 400 });
        try {
          return Response.json({ value: url.pathname === "/secrets/seal" ? seal(cfg, value) : unseal(cfg, value) });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  chmodSync(p.hostSock, 0o600);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} received, stopping isolation`);
    ssh?.close();
    firewall.revert(); // an unconfirmed change never outlives the daemon
    watchdog.stop();
    await recovery.close();
    await stopIsolation();
    server.stop(true);
    hostApi.stop(true);
    rmSync(p.daemonSock, { force: true });
    rmSync(p.hostSock, { force: true });
    images.unmountAll();
    log("bye");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
