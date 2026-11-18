import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { hostname, loadavg, release, totalmem, freemem, uptime } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { ROOT, type KiwinConfig } from "./config";
import { HostShells, type ShellSocket } from "./recovery-shells";
import type { Release, UpdateInfo } from "./updates";

/** xterm, vendored: recovery must work when the panel's files don't. */
const ASSETS: Record<string, string> = {
  "xterm.js": "text/javascript; charset=utf-8",
  "addon-fit.js": "text/javascript; charset=utf-8",
  "xterm.css": "text/css; charset=utf-8",
};
const ASSET_DIR = join(import.meta.dir, "recovery-assets");

export interface RecoveryReason {
  /** swap, system, hang, crash, upgrade or manual. */
  code: string;
  title: string;
  detail: string;
}

export interface RecoveryStatus {
  isolation: "running" | "paused" | "stopped";
  swap: { ok: boolean; detail: string };
  user: { exists: boolean; mounted: boolean; sizeBytes: number | null; freeBytes: number };
}

/** What recovery can do to the system; the daemon implements these. */
export interface RecoveryActions {
  status(): RecoveryStatus;
  /** Stop whatever runs and start the system; opens recovery again if it can't. */
  restart(): Promise<void>;
  /** These four act in place: recovery keeps the port, and the panel stays off. */
  resume(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
  /** Leave recovery: the panel starts on the port again. */
  continueNormal(): Promise<void>;
  createSwap(out: (l: string) => void): Promise<void>;
  /** Stops the isolation first: the image is unmounted while it is resized. */
  resizeUser(gb: number, force: boolean, out: (l: string) => void): Promise<void>;
  checkUpdates(force: boolean): Promise<UpdateInfo>;
  upgrade(out: (l: string) => void, progress: (done: number, total: number) => void): Promise<void>;
  rollback(out: (l: string) => void): Promise<void>;
  /** zstd stream of user.img; the system must be stopped. */
  downloadUser(): ReadableStream<Uint8Array>;
  power(kind: "reboot" | "poweroff"): void;
  verifyPassword(password: string): Promise<boolean>;
}

type Scope = "full" | "upgrade";

interface Job {
  name: string;
  lines: string[];
  done: boolean;
  ok: boolean;
  /** Kiwin goes away when this succeeds: the page waits for the panel. */
  handover: boolean;
  /** Bytes done of a total, for a download. */
  progress: { done: number; total: number; since: number } | null;
}

const COOKIE = "kiwin_recovery";
const SESSION_MS = 30 * 60_000;
const TOKEN_MS = 10 * 60_000;
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;
/** Each further round of wrong passwords doubles the wait, up to this. */
const MAX_LOCK_MS = 30 * 60_000;

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const gb = (bytes: number | null) => (bytes === null ? "-" : `${(bytes / 1024 ** 3).toFixed(1)} GB`);

const STYLE = `
:root { color-scheme: light dark; --bg:#f4f5f7; --card:#fff; --text:#1c2128; --muted:#5f6b7a; --line:#d9dee5; --accent:#1f6feb; --danger:#c62828; --warn-bg:#fff4e5; --warn-text:#8a4b00; --mono:ui-monospace,Menlo,Consolas,monospace; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171c; --card:#1d2127; --text:#e6e9ed; --muted:#9aa5b1; --line:#333a44; --accent:#5b9dff; --danger:#ff7b72; --warn-bg:#3a2a12; --warn-text:#ffc777; } }
* { box-sizing:border-box; }
[hidden] { display:none !important; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:680px; margin:0 auto; padding:32px 16px 48px; }
main.wide { max-width:1200px; }
.head { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
.head nav { display:flex; gap:14px; font-size:14px; }
.head nav a { color:var(--muted); text-decoration:none; }
.head nav a:hover,.head nav a.on { color:var(--text); }
a { color:var(--accent); }
.badge { display:inline-block; padding:1px 7px; border-radius:99px; font-size:12px; font-weight:600; background:var(--bg); border:1px solid var(--line); color:var(--muted); vertical-align:middle; }
.badge.new { color:var(--accent); border-color:var(--accent); }
.badge.ok { color:#1a7f37; border-color:#1a7f37; }
details { margin-top:8px; }
summary { cursor:pointer; color:var(--muted); font-size:14px; }
.rel { padding:10px 0; border-top:1px solid var(--line); }
.rel:first-child { border-top:0; }
.bar { height:8px; border-radius:99px; background:var(--bg); border:1px solid var(--line); overflow:hidden; margin:8px 0 4px; }
.bar > div { height:100%; width:0; background:var(--accent); transition:width .3s; }
.tabs { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:8px; }
.tabs button { padding:5px 10px; font-weight:500; font-size:14px; }
.tabs button.on { border-color:var(--accent); color:var(--accent); }
.tabs .x { padding:0 0 0 6px; border:0; background:none; color:var(--muted); font-size:14px; }
#term { height:calc(100vh - 230px); min-height:320px; background:#0d1117; border-radius:6px; padding:6px; }
.grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; }
.grid2 .card { margin-top:0; }
h1 { font-size:22px; margin:0 0 4px; }
h2 { font-size:16px; margin:0 0 4px; }
p { margin:0 0 10px; }
.muted { color:var(--muted); }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin-top:16px; }
.reason { background:var(--warn-bg); color:var(--warn-text); border-color:transparent; }
.error { color:var(--danger); }
table { width:100%; border-collapse:collapse; }
td { padding:4px 0; vertical-align:top; }
td:first-child { color:var(--muted); width:40%; }
label { display:block; margin-bottom:12px; font-weight:600; }
input[type=password],input[type=number],input[type=text] { display:block; width:100%; margin-top:4px; padding:9px 10px; font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; }
label.check { font-weight:400; display:flex; gap:8px; align-items:center; }
button,.button { display:inline-block; padding:8px 14px; font:inherit; font-weight:600; color:var(--text); background:var(--bg); border:1px solid var(--line); border-radius:6px; cursor:pointer; text-decoration:none; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.danger { color:var(--danger); }
button:disabled { opacity:.5; cursor:not-allowed; }
.option { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:12px 0; border-top:1px solid var(--line); }
.option:first-of-type { border-top:0; }
.option form { margin:0; flex:none; }
.option p { margin:0; font-size:13.5px; }
.option .button,.option button { min-width:110px; text-align:center; }
.foot { margin-top:16px; display:flex; justify-content:space-between; gap:12px; align-items:center; }
.foot form { margin:0; }
pre { margin:0; padding:12px; min-height:120px; max-height:360px; overflow:auto; background:#10141a; color:#d7dde4; border-radius:6px; font:13px/1.45 var(--mono); white-space:pre-wrap; word-break:break-word; }
@media (max-width:520px) { .option { flex-direction:column; align-items:stretch; } .option button,.option .button { width:100%; } }
`;

interface PageOptions {
  /** Signed-in pages get the section links. */
  nav?: "home" | "terminal" | "updates" | "host" | null;
  wide?: boolean;
  head?: string;
}

const NAV: [NonNullable<PageOptions["nav"]>, string, string][] = [
  ["home", "/recovery", "Overview"],
  ["terminal", "/recovery/terminal", "Terminal"],
  ["updates", "/recovery/updates", "Updates"],
  ["host", "/recovery/host", "Host"],
];

const page = (body: string, script = "", opts: PageOptions = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiwin System Recovery</title>
<style>${STYLE}</style>${opts.head ?? ""}
</head>
<body><main${opts.wide ? ' class="wide"' : ""}>
<div class="head"><h1>Kiwin System Recovery</h1>${opts.nav ? `<nav>${NAV.map(([id, href, label]) => `<a href="${href}"${id === opts.nav ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("")}</nav>` : ""}</div>
${body}
</main>${script ? `<script>${script}</script>` : ""}</body>
</html>`;

const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(0)} MB`;
const duration = (s: number) => (s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 86400)} days`);

/** Wait for the system: the panel has no JSON at /recovery/ping, recovery does. */
const WAIT_FOR_PANEL = `
async function waitForPanel(onRecovery) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch("/recovery/ping", { cache: "no-store" });
      const data = res.ok ? await res.json().catch(() => null) : null;
      if (data && data.recovery) { if (onRecovery && onRecovery()) return; continue; }
      location.href = "/";
      return;
    } catch {}
  }
}`;

const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, {
  status,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
});
const go = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });

/**
 * The page that replaces the panel on its port when the isolation can't run.
 * Plain HTML, served by the daemon, depending on nothing in the isolation.
 *
 * A full session needs the host root password. The panel can only ask for an
 * upgrade session, which offers the upgrade and nothing else: root inside the
 * isolation can reach the panel's API, and must not get a host root terminal.
 */
export class Recovery {
  private server: Server<ShellSocket> | null = null;
  private reason: RecoveryReason | null = null;
  private sessions = new Map<string, { scope: Scope; expires: number }>();
  private tokens = new Map<string, { scope: Scope; expires: number }>();
  private failures = 0;
  private lockRounds = 0;
  private lockedUntil = 0;
  private job: Job | null = null;
  private shells = new HostShells();

  constructor(private cfg: KiwinConfig, private log: (l: string) => void, private actions: RecoveryActions) {}

  get active() {
    return this.server !== null;
  }

  get code() {
    return this.reason?.code ?? null;
  }

  get jobRunning() {
    return !!this.job && !this.job.done;
  }

  /** Take the port (the panel may take a moment to let go of it). */
  async open(reason: RecoveryReason) {
    this.reason = reason;
    this.log(`recovery: ${reason.title}. ${reason.detail}`);
    if (this.server) return;
    const { host, port } = this.cfg.recovery;
    for (let i = 0; ; i++) {
      try {
        this.server = Bun.serve<ShellSocket>({
          hostname: host, port, idleTimeout: 0,
          fetch: (req, server) => this.handle(req, server),
          websocket: {
            open: (ws) => this.shells.attach(ws),
            message: (ws, m) => this.shells.message(ws, m),
            close: (ws) => this.shells.detach(ws),
          },
        });
        this.log(`recovery: listening on ${host}:${port}`);
        return;
      } catch (e) {
        if (i >= 40) {
          this.log(`recovery: could not listen on ${port}: ${(e as Error).message}`);
          return;
        }
        await Bun.sleep(250);
      }
    }
  }

  async close() {
    this.shells.closeAll();
    this.sessions.clear();
    this.tokens.clear();
    this.job = null;
    this.reason = null;
    await this.server?.stop(true);
    this.server = null;
  }

  /** A one-time link that signs in without the password. */
  mint(scope: Scope) {
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { scope, expires: Date.now() + TOKEN_MS });
    return token;
  }

  private session(req: Request) {
    const id = /(?:^|;\s*)kiwin_recovery=([0-9a-f]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
    const s = id ? this.sessions.get(id) : undefined;
    if (!id || !s || s.expires < Date.now()) return null;
    s.expires = Date.now() + SESSION_MS;
    return { id, scope: s.scope };
  }

  private signIn(scope: Scope) {
    const id = randomBytes(32).toString("hex");
    this.sessions.set(id, { scope, expires: Date.now() + SESSION_MS });
    return `${COOKIE}=${id}; Path=/recovery; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
  }

  private async handle(req: Request, server: Server<ShellSocket>): Promise<Response | undefined> {
    const url = new URL(req.url);
    // Shell sockets: same origin and a full session (cookies ride along on cross-site sockets too).
    if (url.pathname === "/recovery/term/ws") {
      const origin = req.headers.get("origin");
      const shell = url.searchParams.get("shell") ?? "";
      if (!origin || URL.parse(origin)?.host !== req.headers.get("host")) return new Response("forbidden", { status: 403 });
      if (this.session(req)?.scope !== "full") return new Response("sign in first", { status: 401 });
      if (!this.shells.has(shell)) return new Response("no such shell", { status: 404 });
      if (server.upgrade(req, { data: { shell } })) return undefined;
      return new Response("expected a WebSocket", { status: 400 });
    }
    const asset = /^\/recovery\/assets\/([\w.-]+)$/.exec(url.pathname)?.[1];
    if (asset && ASSETS[asset]) {
      return new Response(Bun.file(join(ASSET_DIR, asset)), { headers: { "content-type": ASSETS[asset], "cache-control": "public, max-age=86400" } });
    }
    const res = await this.route(req).catch((e) => {
      this.log(`recovery: ${(e as Error).stack}`);
      return html(page(`<div class="card"><p class="error">${esc((e as Error).message)}</p><a class="button" href="/recovery">Back</a></div>`), 500);
    });
    res.headers.set("cache-control", "no-store");
    // Not no-referrer: browsers then send Origin: null on our own forms.
    res.headers.set("referrer-policy", "same-origin");
    res.headers.set("x-frame-options", "DENY");
    res.headers.set("x-content-type-options", "nosniff");
    res.headers.set("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return res;
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/recovery/ping") return Response.json({ recovery: true, code: this.reason?.code });
    if (path !== "/recovery" && !path.startsWith("/recovery/")) return go("/recovery");

    if (req.method === "POST") {
      const origin = req.headers.get("origin");
      if (origin && URL.parse(origin)?.host !== req.headers.get("host")) return new Response("forbidden", { status: 403 });
    }

    const token = url.searchParams.get("t");
    if (path === "/recovery" && token) return this.useToken(token);
    if (path === "/recovery/login" && req.method === "POST") return this.login(req);

    const session = this.session(req);
    if (!session) return req.method === "GET" && path === "/recovery" ? html(this.loginPage()) : go("/recovery");

    const upgradeOnly = session.scope === "upgrade";
    if (upgradeOnly && !["/recovery", "/recovery/updates", "/recovery/task", "/recovery/job", "/recovery/do/upgrade", "/recovery/do/restart"].includes(path)) {
      return new Response("forbidden", { status: 403 });
    }

    if (req.method === "GET") {
      switch (path) {
        case "/recovery": return upgradeOnly ? go("/recovery/updates") : html(this.home());
        case "/recovery/updates": return html(await this.updatesPage(url.searchParams.has("check"), upgradeOnly));
        case "/recovery/user": return html(this.userPage());
        case "/recovery/terminal": return html(this.terminalPage());
        case "/recovery/term/list": return Response.json(this.shells.list());
        case "/recovery/host": return html(this.hostPage());
        case "/recovery/download/user.img.zst": return this.downloadUser();
        case "/recovery/task": return html(this.taskPage());
        case "/recovery/job": return Response.json(this.job);
      }
    } else if (req.method === "POST") {
      switch (path) {
        case "/recovery/logout":
          this.sessions.delete(session.id);
          return go("/recovery", { "set-cookie": `${COOKIE}=; Path=/recovery; Max-Age=0` });
        case "/recovery/do/restart": return this.leave(() => this.actions.restart(), "The system is restarting.");
        case "/recovery/do/resume": await this.actions.resume(); return go("/recovery");
        case "/recovery/do/pause": await this.actions.pause(); return go("/recovery");
        case "/recovery/do/stop": await this.actions.stop(); return go("/recovery");
        case "/recovery/do/start": await this.actions.start(); return go("/recovery");
        case "/recovery/do/continue":
          if (this.actions.status().isolation !== "running") return go("/recovery");
          return this.leave(() => this.actions.continueNormal(), "Starting the normal interface.");
        case "/recovery/do/swap":
          return this.start("Creating the swap file", false, async (out) => {
            await this.actions.createSwap(out);
            // The swap file was all that held the system back.
            if (this.reason?.code === "swap") setTimeout(() => void this.closeThen(() => this.actions.restart()), 1500);
          }, this.reason?.code === "swap");
        case "/recovery/do/resize": {
          const form = await req.formData();
          const size = Math.floor(Number(form.get("size")));
          if (!Number.isFinite(size) || size < 1) return html(this.userPage("Enter a size in GB"), 400);
          return this.start("Resizing user.img", false, (out) => this.actions.resizeUser(size, form.get("force") === "on", out));
        }
        case "/recovery/do/upgrade": return this.start("Upgrading Kiwin", true, (out, progress) => this.actions.upgrade(out, progress));
        case "/recovery/do/rollback": return this.start("Rolling back Kiwin", true, (out) => this.actions.rollback(out));
        case "/recovery/do/reboot":
        case "/recovery/do/poweroff": {
          const kind = path.endsWith("reboot") ? "reboot" : "poweroff";
          // Powering off can't be undone from here: the hostname, typed, guards it.
          if (kind === "poweroff" && String((await req.formData()).get("confirm") ?? "").trim() !== hostname()) {
            return html(this.hostPage("Type the server's hostname exactly to power it off."), 400);
          }
          this.actions.power(kind);
          return html(page(`<div class="card"><h2>${kind === "reboot" ? "The server is rebooting." : "The server is powering off."}</h2>
<p class="muted">${kind === "reboot" ? "This page reconnects when the server is back, usually within a few minutes." : "Start it again from your hosting provider's console."}</p></div>`,
          kind === "reboot" ? `${WAIT_FOR_PANEL}\nsetTimeout(() => waitForPanel(() => { location.href = "/recovery"; return true; }), 15000);` : ""));
        }
        case "/recovery/term/new": {
          const { cols, rows } = (await req.json().catch(() => ({}))) as { cols?: number; rows?: number };
          try {
            return Response.json({ id: this.shells.create(Number(cols), Number(rows)) });
          } catch (e) {
            return Response.json({ error: (e as Error).message }, { status: 400 });
          }
        }
        case "/recovery/term/close": {
          const { id } = (await req.json().catch(() => ({}))) as { id?: string };
          if (id) this.shells.close(id);
          return new Response(null, { status: 204 });
        }
      }
    }
    return new Response("not found", { status: 404 });
  }

  private useToken(token: string) {
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    if (!entry || entry.expires < Date.now()) return html(this.loginPage("That link has expired or was already used."), 403);
    // A page rather than a redirect: browsers can withhold a SameSite=Strict
    // cookie on a redirect that a link in another program started.
    return html(`<!doctype html><meta http-equiv="refresh" content="0;url=/recovery"><title>Kiwin System Recovery</title>`, 200, { "set-cookie": this.signIn(entry.scope) });
  }

  private async login(req: Request) {
    const now = Date.now();
    if (now < this.lockedUntil) return html(this.loginPage(`Too many attempts. Try again in ${Math.ceil((this.lockedUntil - now) / 1000)} seconds.`), 429);
    const password = String((await req.formData()).get("password") ?? "");
    if (await this.actions.verifyPassword(password).catch(() => false)) {
      this.failures = 0;
      this.lockRounds = 0;
      this.log(`recovery: signed in with the root password from ${this.server?.requestIP(req)?.address}`);
      return go("/recovery", { "set-cookie": this.signIn("full") });
    }
    this.log(`recovery: wrong root password from ${this.server?.requestIP(req)?.address}`);
    if (++this.failures >= MAX_FAILURES) {
      this.failures = 0;
      this.lockedUntil = now + Math.min(MAX_LOCK_MS, LOCK_MS * 2 ** Math.min(this.lockRounds++, 10));
    }
    return html(this.loginPage("That is not the host's root password."), 401);
  }

  /** Answer first: closing the server ends this very request. */
  private leave(action: () => Promise<void>, message: string) {
    setTimeout(() => void this.closeThen(action), 300);
    return html(page(`<div class="card"><h2>${esc(message)}</h2><p class="muted">This page moves on to the panel when it is ready.</p></div>`, `${WAIT_FOR_PANEL}
waitForPanel(() => { location.href = "/recovery"; return true; });`));
  }

  private async closeThen(action: () => Promise<void>) {
    await this.close();
    await action().catch((e) => this.log(`recovery: ${(e as Error).message}`));
  }

  private start(
    name: string,
    handover: boolean,
    run: (out: (l: string) => void, progress: (done: number, total: number) => void) => Promise<void>,
    returning = handover,
  ) {
    if (this.jobRunning) return go("/recovery/task");
    const job: Job = { name, lines: [], done: false, ok: false, handover: returning, progress: null };
    this.job = job;
    const out = (l: string) => job.lines.push(l);
    const progress = (done: number, total: number) => {
      job.progress = { done, total, since: job.progress?.since ?? Date.now() };
    };
    run(out, progress).then(
      () => (job.ok = true),
      (e) => out(`Error: ${(e as Error).message}`),
    ).finally(() => (job.done = true));
    return go("/recovery/task");
  }

  // ---- Pages ------------------------------------------------------------------

  private reasonCard() {
    const r = this.reason;
    return r ? `<div class="card reason"><h2>${esc(r.title)}</h2><p style="margin:0">${esc(r.detail)}</p></div>` : "";
  }

  /** Cloud images usually ship with root locked: then only the command line can get in. */
  private rootLocked() {
    try {
      const hash = /^root:([^:]*):/m.exec(readFileSync("/etc/shadow", "utf8"))?.[1] ?? "";
      return hash === "" || hash.startsWith("!") || hash.startsWith("*");
    } catch {
      return false;
    }
  }

  private loginPage(error?: string) {
    const locked = this.rootLocked();
    return page(`
${this.reasonCard()}
<div class="card">
  <h2>Host Root Password Verification</h2>
  <p class="muted">Enter the root password of this server, not your panel password.</p>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
  ${locked ? `<p class="error">Root has no password on this server. Over SSH, set one with <code>sudo passwd root</code>, or run <code>sudo kiwin recovery</code> for a one-time sign-in link.</p>` : ""}
  <form method="post" action="/recovery/login">
    <label>Root password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
    <button type="submit" class="primary">Verify</button>
  </form>
  <p class="muted" style="margin:12px 0 0;font-size:13px">This page uses plain HTTP unless the address starts with https. On an untrusted network, use <code>sudo kiwin recovery</code> through an SSH tunnel instead.</p>
</div>`);
  }

  private option(title: string, about: string, action: string) {
    return `<div class="option"><div><strong>${esc(title)}</strong><p class="muted">${esc(about)}</p></div>${action}</div>`;
  }

  private post(to: string, label: string, opts: { confirm?: string; disabled?: boolean; primary?: boolean; danger?: boolean } = {}) {
    // The text stays out of the script: read from an attribute, never spliced into JS.
    const onsubmit = opts.confirm ? ` data-confirm="${esc(opts.confirm)}" onsubmit="return confirm(this.dataset.confirm)"` : "";
    const cls = opts.primary ? ' class="primary"' : opts.danger ? ' class="danger"' : "";
    return `<form method="post" action="${to}"${onsubmit}><button type="submit"${cls}${opts.disabled ? " disabled" : ""}>${esc(label)}</button></form>`;
  }

  private home() {
    const s = this.actions.status();
    const paused = s.isolation === "paused";
    const running = s.isolation === "running";
    const state = { running: "Running", paused: "Paused (frozen)", stopped: "Stopped" }[s.isolation];
    return page(`
${this.reasonCard()}
<div class="card">
  <table>
    <tr><td>System</td><td>${state}</td></tr>
    <tr><td>Swap file</td><td>${esc(s.swap.detail)}</td></tr>
    <tr><td>User storage</td><td>${s.user.exists ? `${gb(s.user.sizeBytes)}${s.user.mounted ? ", mounted" : ", not mounted"}` : "Not created"}</td></tr>
    <tr><td>Free disk space</td><td>${gb(s.user.freeBytes)}</td></tr>
  </table>
</div>
<div class="card">
  ${s.swap.ok ? "" : this.option("Create Swap File", `Required before the system can start. Makes ${this.cfg.recovery.swapFile} (${this.cfg.recovery.swapSize}), taken out of user storage if the disk is short of space.`, this.post("/recovery/do/swap", "Create", { primary: true }))}
  ${running ? this.option("Continue to Normal Interface", "Starts the panel again and leaves recovery.", this.post("/recovery/do/continue", "Continue", { primary: true })) : ""}
  ${paused
    ? this.option("Force Resume", "Unfreezes the system as it was. The panel stays off until you continue to the normal interface.", this.post("/recovery/do/resume", "Resume"))
    : running
      ? this.option("Pause System", "Freezes every program in the system where it is. Nothing is lost; resume it later.", this.post("/recovery/do/pause", "Pause"))
      : this.option("Start System", "Starts the system in the background, without the panel.", this.post("/recovery/do/start", "Start", { disabled: !s.swap.ok }))}
  ${this.option("Stop System", "Stops everything in the system: websites, databases, mail.", this.post("/recovery/do/stop", "Stop", { danger: true, disabled: s.isolation === "stopped", confirm: "Stop everything in the system?" }))}
  ${this.option("Emergency Restart", "Stops everything in the system at once and starts it again. Unsaved work in running programs is lost.", this.post("/recovery/do/restart", "Restart", { danger: true, disabled: !s.swap.ok, confirm: "Stop everything and restart the system?" }))}
  ${this.option("Manage Terminal", "Root shells on the host, in tabs, with a full terminal.", `<a class="button" href="/recovery/terminal">Open</a>`)}
  ${this.option("Manage User Size", "Grow or shrink user.img.", `<a class="button" href="/recovery/user">Open</a>`)}
  ${this.option("Check for Updates", "Releases, upgrades and rollback.", `<a class="button" href="/recovery/updates?check">Check</a>`)}
  ${this.option("Host Controls", "Reboot or power off the server, download user.img.", `<a class="button" href="/recovery/host">Open</a>`)}
</div>
<div class="foot"><span></span>${this.post("/recovery/logout", "Sign out")}</div>`, "", { nav: "home" });
  }

  private downloadUser() {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = this.actions.downloadUser();
    } catch (e) {
      return html(this.hostPage((e as Error).message), 409);
    }
    this.log("recovery: user.img download started");
    return new Response(stream, {
      headers: {
        "content-type": "application/zstd",
        "content-disposition": `attachment; filename="user-${hostname().replace(/[^\w.-]/g, "_")}-${stamp}.img.zst"`,
      },
    });
  }

  private hostPage(error?: string) {
    const s = this.actions.status();
    const disk = statfsSync("/");
    const total = disk.blocks * disk.bsize;
    const free = disk.bavail * disk.bsize;
    const mem = totalmem();
    const load = loadavg().map((l) => l.toFixed(2)).join(" · ");
    let version = "development";
    try {
      version = readFileSync(join(ROOT, "VERSION"), "utf8").trim() || version;
    } catch {}
    const canDownload = s.user.exists && s.isolation === "stopped";
    return page(`
${error ? `<div class="card reason"><p class="error" style="margin:0" role="alert">${esc(error)}</p></div>` : ""}
<div class="card">
  <h2>${esc(hostname())}</h2>
  <table>
    <tr><td>Kernel</td><td>${esc(release())}</td></tr>
    <tr><td>Up for</td><td>${duration(uptime())}</td></tr>
    <tr><td>Load (1, 5, 15 min)</td><td>${load}</td></tr>
    <tr><td>Memory</td><td>${gb(mem - freemem())} used of ${gb(mem)}</td></tr>
    <tr><td>Disk (/)</td><td>${gb(total - free)} used of ${gb(total)}, ${gb(free)} free</td></tr>
    <tr><td>Kiwin</td><td>${esc(version)}</td></tr>
  </table>
</div>
<div class="card">
  ${this.option("Download user.img", canDownload
    ? `All your data (${gb(s.user.sizeBytes)} image), compressed with zstd. It is unmounted while it downloads. To move it to another server, put it there as images/user.img.zst before Kiwin first starts.`
    : s.user.exists ? "Stop the system first (Overview → Stop System): the image must not change while it is copied." : "There is no user.img yet.",
    canDownload ? `<a class="button" href="/recovery/download/user.img.zst" download>Download</a>` : `<button disabled>Download</button>`)}
  ${this.option("Reboot Server", "Restarts the whole machine. Kiwin stops cleanly first and starts again on boot.",
    this.post("/recovery/do/reboot", "Reboot", { danger: true, confirm: `Reboot ${hostname()} now?` }))}
  <div class="option"><div><strong>Power Off Server</strong><p class="muted">Shuts the machine down. Only your hosting provider's console can start it again. Type the hostname <code>${esc(hostname())}</code> to confirm.</p>
    <form id="poweroff" method="post" action="/recovery/do/poweroff" style="margin-top:8px"><input type="text" name="confirm" autocomplete="off" spellcheck="false" aria-label="Hostname" placeholder="${esc(hostname())}" style="max-width:260px"></form></div>
    <button type="submit" form="poweroff" class="danger">Power off</button></div>
</div>`, "", { nav: "host" });
  }

  private userPage(error?: string) {
    const s = this.actions.status();
    const current = s.user.sizeBytes === null ? "" : Math.round(s.user.sizeBytes / 1024 ** 3);
    return page(`
<div class="card">
  <h2>Manage User Size</h2>
  <table>
    <tr><td>user.img</td><td>${gb(s.user.sizeBytes)}</td></tr>
    <tr><td>Free disk space</td><td>${gb(s.user.freeBytes)}</td></tr>
  </table>
</div>
<div class="card">
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
  ${s.user.exists ? `
  <p class="muted">The system is stopped while user.img is resized${s.isolation === "stopped" ? "" : ", which ends everything running in it"}. Shrinking moves your data and can take a long time. Keep a backup. If the data doesn't fit, nothing is lost.</p>
  <form method="post" action="/recovery/do/resize" onsubmit="return confirm('Stop the system and resize user.img?')">
    <label>New size (GB)<input type="number" name="size" min="1" value="${current}" required></label>
    <label class="check"><input type="checkbox" name="force"> Force: allow more than the free disk space</label>
    <button type="submit" class="primary">Resize</button>
  </form>` : `<p>There is no user.img yet. It is created in the panel on first setup.</p>`}
</div>
<div class="foot"><a class="button" href="/recovery">Back</a></div>`, "", { nav: "home" });
  }

  private async updatesPage(check: boolean, upgradeOnly: boolean) {
    const u = await this.actions.checkUpdates(check);
    const latest = u.latest;
    const status = u.error ? "" : u.available ? `<span class="badge new">Update available</span>` : latest ? `<span class="badge ok">Up to date</span>` : "";
    const last = u.last
      ? `<p class="${u.last.ok ? "muted" : "error"}" style="margin:8px 0 0">Last upgrade ${u.last.ok ? "succeeded" : "failed and was rolled back"} on ${esc(new Date(u.last.at).toUTCString())}.</p>
  ${u.lastLog ? `<details><summary>Log of the last upgrade</summary><pre style="margin-top:8px">${esc(u.lastLog)}</pre></details>` : ""}`
      : "";
    const history = u.releases.map((r) => {
      const cmp = r.version === u.current ? `<span class="badge ok">Installed</span>` : r === latest && u.available ? `<span class="badge new">Latest</span>` : "";
      return `<div class="rel">
    <div class="head"><strong><a href="${esc(r.pageUrl)}" target="_blank" rel="noreferrer">${esc(r.version)}</a></strong>
      <span class="muted" style="font-size:13px">${esc(new Date(r.publishedAt).toUTCString())} · ${mb(r.size)}</span></div>
    <div style="margin-top:2px">${r.prerelease ? `<span class="badge">Pre-release</span> ` : ""}${cmp} <span class="muted" style="font-size:13px">${esc(r.tag)}</span></div>
    ${r.notes ? `<details${r === latest ? " open" : ""}><summary>Release notes</summary><pre style="min-height:0;margin-top:6px">${esc(r.notes)}</pre></details>` : ""}
  </div>`;
    }).join("");
    return page(`
${upgradeOnly ? this.reasonCard() : ""}
<div class="card">
  <div class="head"><h2>Kiwin ${esc(u.current)} ${status}</h2><a class="button" href="/recovery/updates?check">Check now</a></div>
  <p class="muted" style="margin:0">From github.com/${esc(this.cfg.recovery.repo)} releases, pre-releases included.${u.checkedAt ? ` Checked ${esc(new Date(u.checkedAt).toUTCString())}.` : ""}</p>
  ${u.error ? `<p class="error" style="margin:8px 0 0">${esc(u.error)}</p>` : ""}
  ${last}
</div>
${u.available && latest ? `<div class="card">
  <h2>Upgrade to ${esc(latest.version)}</h2>
  <p>Downloads ${mb(latest.size)}, then the system stays down while Kiwin upgrades and comes back on the new version. Your data and settings are kept, and a failed upgrade goes back to the current version by itself.</p>
  ${this.post("/recovery/do/upgrade", "Upgrade now", { primary: true, confirm: `Download ${latest.version} and upgrade now?` })}
</div>` : ""}
${!upgradeOnly && u.canRollback ? `<div class="card">
  ${this.option("Roll Back", "Go back to the version the last upgrade replaced, code and system image. Your data is kept.", this.post("/recovery/do/rollback", "Roll back", { danger: true, confirm: "Go back to the previous version of Kiwin? The system stops while it does." }))}
</div>` : ""}
${history ? `<div class="card"><h2>Releases</h2>${history}</div>` : ""}
<div class="foot">${upgradeOnly ? this.post("/recovery/do/restart", "Cancel and start the system") : ""}</div>`, "", { nav: upgradeOnly ? null : "updates" });
  }

  private taskPage() {
    const job = this.job;
    if (!job) return page(`<div class="card"><p>Nothing is running.</p><a class="button" href="/recovery">Back</a></div>`);
    return page(`
<div class="card">
  <h2>${esc(job.name)}</h2>
  <p id="state" class="muted" role="status">Working…</p>
  <div id="prog" hidden><div class="bar"><div id="fill"></div></div><p id="rate" class="muted" style="font-size:13px"></p></div>
  <pre id="log"></pre>
</div>
<div class="foot"><a id="back" class="button" href="/recovery" hidden>Back</a></div>`, `${WAIT_FOR_PANEL}
const log = document.getElementById("log"), state = document.getElementById("state"), back = document.getElementById("back");
const prog = document.getElementById("prog"), fill = document.getElementById("fill"), rate = document.getElementById("rate");
const MB = (b) => (b / 1048576).toFixed(1) + " MB";
function waiting() {
  state.textContent = "Waiting for Kiwin to come back. This can take a few minutes, and the page moves on by itself.";
  // Back in recovery with no task: the system could not start, or the upgrade was undone.
  waitForPanel(() => { fetch("/recovery/job").then((r) => r.json()).then((j) => { if (!j) location.href = "/recovery"; }).catch(() => { location.href = "/recovery"; }); return false; });
}
async function poll() {
  for (;;) {
    let job;
    try {
      const res = await fetch("/recovery/job", { cache: "no-store" });
      job = res.ok ? await res.json() : null;
    } catch { job = null; }
    if (!job) return waiting();
    log.textContent = job.lines.join("\\n");
    log.scrollTop = log.scrollHeight;
    const p = job.progress;
    if (p && p.total) {
      prog.hidden = false;
      fill.style.width = Math.min(100, (p.done / p.total) * 100).toFixed(1) + "%";
      const secs = Math.max(1, (Date.now() - p.since) / 1000), speed = p.done / secs;
      const left = speed > 0 ? Math.round((p.total - p.done) / speed) : 0;
      rate.textContent = MB(p.done) + " of " + MB(p.total) + " · " + MB(speed) + "/s" + (p.done < p.total ? " · about " + (left > 90 ? Math.round(left / 60) + " min" : left + " s") + " left" : "");
    }
    if (job.done) {
      if (job.ok && job.handover) return waiting();
      state.textContent = job.ok ? "Done." : "Failed: see the last lines above.";
      back.hidden = false;
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
poll();`);
  }

  private terminalPage() {
    return page(`
<div class="card">
  <div class="tabs" id="tabs" role="tablist" aria-label="Shells"></div>
  <div id="term"></div>
  <p class="muted" style="font-size:13px;margin:8px 0 0">Root on the host, not inside the system. Shells keep running when you leave this page, until you close them or leave recovery.</p>
</div>`, `
const tabs = document.getElementById("tabs"), host = document.getElementById("term");
const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, fontFamily: "ui-monospace, Menlo, Consolas, monospace",
  theme: { background: "#0d1117", foreground: "#e6edf3", cursor: "#58a6ff", selectionBackground: "#58a6ff55" } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(host);
fit.fit();
let ws = null, current = null, shells = [];
const enc = new TextEncoder();

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}
function render() {
  tabs.textContent = "";
  for (const s of shells) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(s.id === current));
    b.className = s.id === current ? "on" : "";
    b.textContent = s.title + (s.exited ? " (exited)" : "");
    b.onclick = () => connect(s.id);
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.title = "Close " + s.title;
    x.onclick = (e) => { e.stopPropagation(); closeShell(s.id); };
    b.appendChild(x);
    tabs.appendChild(b);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "+ New shell";
  add.onclick = () => newShell();
  tabs.appendChild(add);
}
async function refresh() { shells = await api("/recovery/term/list"); render(); }
function sendSize() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ resize: [term.cols, term.rows] })); }
function connect(id) {
  if (ws) { ws.onclose = null; ws.close(); }
  current = id;
  term.reset();
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/recovery/term/ws?shell=" + id);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => term.write(new Uint8Array(e.data));
  ws.onopen = () => { sendSize(); term.focus(); };
  ws.onclose = () => refresh().catch(() => {});
  render();
}
async function newShell() {
  try {
    const { id } = await api("/recovery/term/new", { cols: term.cols, rows: term.rows });
    await refresh();
    connect(id);
  } catch (e) { term.write("\\r\\n" + e.message + "\\r\\n"); }
}
async function closeShell(id) {
  await api("/recovery/term/close", { id }).catch(() => {});
  if (id === current) { current = null; if (ws) { ws.onclose = null; ws.close(); ws = null; } term.reset(); }
  await refresh();
  if (!current && shells.length) connect(shells[0].id);
}
term.onData((d) => { if (ws && ws.readyState === 1) ws.send(enc.encode(d)); });
new ResizeObserver(() => { fit.fit(); sendSize(); }).observe(host);
refresh().then(() => (shells.length ? connect(shells[0].id) : newShell()));`, {
      nav: "terminal", wide: true,
      head: `\n<link rel="stylesheet" href="/recovery/assets/xterm.css">\n<script src="/recovery/assets/xterm.js"></script>\n<script src="/recovery/assets/addon-fit.js"></script>`,
    });
  }
}

/**
 * Check a password against the host's root account with PAM's own helper, which
 * reads it from a pipe, NUL-terminated, and knows every hash /etc/shadow can hold.
 */
export async function verifyRootPassword(password: string) {
  if (!password || password.length > 512 || password.includes("\0")) return false;
  const helper = ["/usr/sbin/unix_chkpwd", "/sbin/unix_chkpwd", "/run/wrappers/bin/unix_chkpwd"].find(existsSync);
  if (!helper) throw new Error("unix_chkpwd not found");
  const p = Bun.spawn([helper, "root", "nonull"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  p.stdin.write(`${password}\0`);
  await p.stdin.end();
  return (await p.exited) === 0;
}
