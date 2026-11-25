import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agent } from "./host";
import { SocketBridges } from "./socket-bridge";

// "X.org Interface": an Xvnc desktop (TigerVNC + Openbox + tint2 + xterm)
// installed from Software onto user.img, shown in the panel with noVNC.
//
//   /www/softwares/xorg/current/root   the packages' files
//   /www/softwares/xorg/session.sh     starts X and the desktop (written here)
//   /www/.desktop                      HOME of the desktop session (configs, files)
//   /www/services/desktop.json         its isol unit
//   /run/kiwi-desktop/vnc.sock         Xvnc's VNC socket (root only, no TCP port)
//
// The browser reaches it through a SocketBridges bridge (see lib/socket-bridge.ts),
// the same transport the Virtual Machines console uses.

const ROOT = "/www/softwares/xorg/current/root";
const SESSION = "/www/softwares/xorg/session.sh";
/** gdk-pixbuf's image loader list; GTK can't even show its own PNG icons without it. */
const PIXBUF_CACHE = "/www/softwares/xorg/pixbuf-loaders.cache";
const PIXBUF_DIR = `${ROOT}/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0`;
export const DESKTOP_HOME = "/www/.desktop";
const UNIT = "desktop";
const UNIT_FILE = `/www/services/${UNIT}.json`;
const SOCKET = "/run/kiwi-desktop/vnc.sock";
/** High display number: the isolation shares the host's network namespace (and so X's abstract sockets). */
const DISPLAY = ":77";
/** The session's X cookie: without it any local user (a website's PHP) could type into root's desktop. */
const XAUTHORITY = "/run/kiwi-desktop/Xauthority";
const MAX_BRIDGES = 4;

const SESSION_SCRIPT = `#!/bin/sh
# Written by kiwi: the X.org Interface session, viewed from the panel's Desktop page.
# Xvnc listens only on a root-only unix socket; there is no VNC port.
R=${ROOT}
export LD_LIBRARY_PATH="$R/usr/lib/x86_64-linux-gnu:$R/lib/x86_64-linux-gnu:$R/usr/lib"
export PATH="$R/usr/bin:/www/softwares/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export XDG_DATA_DIRS="$R/usr/share:/usr/share" XDG_CONFIG_DIRS="$R/etc/xdg"
export FONTCONFIG_FILE="$R/etc/fonts/fonts.conf" FONTCONFIG_PATH="$R/etc/fonts"
export HOME=${DESKTOP_HOME} LANG=C.UTF-8 DISPLAY=${DISPLAY}
# GTK (and so every GTK or Electron app) needs its GSettings schemas; apps with their own export a combined set.
[ -f "$R/usr/share/glib-2.0/schemas/gschemas.compiled" ] && export GSETTINGS_SCHEMA_DIR="$R/usr/share/glib-2.0/schemas"
[ -f ${PIXBUF_CACHE} ] && export GDK_PIXBUF_MODULE_FILE=${PIXBUF_CACHE}

mkdir -p "$HOME" /tmp/.X11-unix /run/kx /run/kiwi-desktop
chmod 1777 /tmp/.X11-unix
chmod 700 /run/kiwi-desktop
# Only programs holding this cookie may connect to the display (root's, in a root-only folder).
# Written by hand in the Xauthority format (any host, this display, MIT-MAGIC-COOKIE-1): xauth may not be installed.
export XAUTHORITY=${XAUTHORITY}
( umask 077
  { printf '\\377\\377\\000\\000\\000\\002%s\\000\\022MIT-MAGIC-COOKIE-1\\000\\020' ${DISPLAY.slice(1)}
    for b in $(od -An -N16 -tu1 /dev/urandom); do printf "\\\\$(printf '%03o' "$b")"; done
  } > "$XAUTHORITY" )
# Xvnc looks for its keymap compiler in /run/kx (patched in at install time).
ln -sfn "$R/usr/bin/xkbcomp" /run/kx/xkbcomp
rm -f ${SOCKET} /tmp/.X${DISPLAY.slice(1)}-lock /tmp/.X11-unix/X${DISPLAY.slice(1)}

trap 'kill $(jobs -p) 2>/dev/null; exit 0' TERM INT

Xtigervnc ${DISPLAY} -desktop kiwin -geometry 1600x900 -depth 24 \\
  -rfbunixpath ${SOCKET} -rfbunixmode 0600 -rfbport -1 -SecurityTypes None -AlwaysShared \\
  -auth "$XAUTHORITY" -nolisten tcp -nolisten local -xkbdir "$R/usr/share/X11/xkb" &
XVNC=$!
i=0
while [ ! -S /tmp/.X11-unix/X${DISPLAY.slice(1)} ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done

xsetroot -solid '#2b2024' 2>/dev/null
xrdb -nocpp -merge "$HOME/.Xresources" 2>/dev/null
tint2 >/dev/null 2>&1 &
xterm >/dev/null 2>&1 &
openbox &
wait $XVNC
`;

/** Write `content` unless the file already has it; true when it changed. */
function writeIfChanged(file: string, content: string, mode = 0o644): boolean {
    try {
        if (readFileSync(file, "utf8") === content) return false;
    } catch {}
    writeFileSync(file, content, { mode });
    return true;
}

/** A generated file is missing or older than the directory it is generated from. */
function staleAgainst(output: string, source: string): boolean {
    try {
        return statSync(output).mtimeMs < statSync(source).mtimeMs;
    } catch {
        return true;
    }
}

export interface DesktopApp {
    name: string;
    command: string;
}

const xml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Openbox's right-click menu: Terminal, then the desktop apps installed from Software. */
function menu(apps: DesktopApp[]): string {
    const item = (label: string, command: string) => `    <item label="${xml(label)}"><action name="Execute"><command>${xml(command)}</command></action></item>`;
    return [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<!-- Written by kiwi and rewritten when desktop apps are installed or removed. -->`,
        `<openbox_menu xmlns="http://openbox.org/3.4/menu">`,
        `  <menu id="root-menu" label="kiwin">`,
        item("Terminal", "xterm"),
        ...(apps.length ? ["    <separator />", ...apps.map((a) => item(a.name, a.command))] : []),
        "    <separator />",
        `    <item label="Reconfigure Openbox"><action name="Reconfigure" /></item>`,
        "  </menu>",
        "</openbox_menu>",
        "",
    ].join("\n");
}

const XRESOURCES = `! Written by kiwi on first install; edit freely.
XTerm*faceName: DejaVu Sans Mono
XTerm*faceSize: 11
XTerm*background: #141012
XTerm*foreground: #f1e9e9
XTerm*cursorColor: #ef5350
XTerm*scrollBar: false
XTerm*saveLines: 5000
XTerm*selectToClipboard: true
XTerm*loginShell: true
`;

const TINT2RC = `# Written by kiwi on first install; edit freely (or run tint2conf).
panel_items = LTSC
panel_size = 100% 34
panel_position = bottom center horizontal
panel_background_id = 1
panel_padding = 6 3 6
font_shadow = 0
rounded = 0
border_width = 0
background_color = #1c1719 100
border_color = #33282b 100
rounded = 6
border_width = 1
background_color = #33282b 100
border_color = #46373b 100
launcher_padding = 2 2 4
launcher_icon_size = 22
launcher_item_app = ${ROOT}/usr/share/applications/debian-xterm.desktop
taskbar_mode = single_desktop
taskbar_padding = 2 2 4
task_text = 1
task_icon = 1
task_maximum_size = 200 32
task_padding = 6 3 6
task_font = DejaVu Sans 9
task_font_color = #f5ecec 90
task_background_id = 0
task_active_background_id = 2
systray_padding = 4 2 4
time1_format = %H:%M
time2_format = %a %d %b
time1_font = DejaVu Sans Bold 9
time2_font = DejaVu Sans 7
clock_font_color = #f5ecec 100
clock_padding = 6 0
`;

const bridges = new SocketBridges("desktop", MAX_BRIDGES);

export class KiwiDesktop {
    static isInstalled(): boolean {
        return existsSync(join(ROOT, "usr/bin/Xtigervnc"));
    }

    /** Rewrite Openbox's menu with `apps` and tell a running Openbox to reload it. */
    static async writeMenu(apps: DesktopApp[]): Promise<void> {
        const file = join(DESKTOP_HOME, ".config/openbox/menu.xml");
        mkdirSync(join(file, ".."), { recursive: true, mode: 0o755 });
        if (!writeIfChanged(file, menu(apps))) return;
        if (existsSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`)) {
            Bun.spawnSync(["openbox", "--reconfigure"], {
                env: { ...process.env, DISPLAY, XAUTHORITY, PATH: `${ROOT}/usr/bin:${process.env.PATH}`, LD_LIBRARY_PATH: `${ROOT}/usr/lib/x86_64-linux-gnu:${ROOT}/lib/x86_64-linux-gnu`, HOME: DESKTOP_HOME },
                stdout: "ignore",
                stderr: "ignore",
            });
        }
    }

    /** Write the session script, first-run configs, the menu and the (on-demand) unit. */
    static async provision(apps: DesktopApp[] = []): Promise<void> {
        if (!this.isInstalled()) throw new Error("X.org Interface is not installed");
        // Runs before every desktop start, so each step only does work when its output is stale.
        const sessionChanged = writeIfChanged(SESSION, SESSION_SCRIPT, 0o755);
        // GLib tells file types apart (a PNG from a JPEG…) with shared-mime-info's database,
        // which its maintainer script builds; without it GTK can't even load its own icons.
        const env = { ...process.env, LD_LIBRARY_PATH: `${ROOT}/usr/lib/x86_64-linux-gnu:${ROOT}/lib/x86_64-linux-gnu` };
        const mimeDir = join(ROOT, "usr/share/mime");
        if (existsSync(join(ROOT, "usr/bin/update-mime-database")) && staleAgainst(join(mimeDir, "mime.cache"), join(mimeDir, "packages"))) {
            Bun.spawnSync([join(ROOT, "usr/bin/update-mime-database"), mimeDir], { env, stdout: "ignore", stderr: "ignore" });
        }
        // What gdk-pixbuf's maintainer script would write to its fixed system path.
        const query = join(PIXBUF_DIR, "../gdk-pixbuf-query-loaders");
        if (existsSync(query) && staleAgainst(PIXBUF_CACHE, join(PIXBUF_DIR, "loaders"))) {
            const loaders = readdirSync(join(PIXBUF_DIR, "loaders")).filter((f) => f.endsWith(".so")).map((f) => join(PIXBUF_DIR, "loaders", f));
            const q = Bun.spawnSync([query, ...loaders], {
                env,
                stdout: "pipe",
                stderr: "pipe",
            });
            if (q.exitCode === 0) writeFileSync(PIXBUF_CACHE, q.stdout);
        }
        const once = (file: string, content: string) => {
            mkdirSync(join(file, ".."), { recursive: true, mode: 0o755 });
            if (!existsSync(file)) writeFileSync(file, content);
        };
        await this.writeMenu(apps);
        once(join(DESKTOP_HOME, ".config/tint2/tint2rc"), TINT2RC);
        once(join(DESKTOP_HOME, ".Xresources"), XRESOURCES);
        mkdirSync("/www/services", { recursive: true, mode: 0o755 });
        // Keep "start at boot" if it was switched on from the Services page.
        let enabled = false;
        try {
            enabled = JSON.parse(readFileSync(UNIT_FILE, "utf8")).enabled === true;
        } catch {}
        const unitChanged = writeIfChanged(UNIT_FILE, JSON.stringify({
            description: "X.org Interface desktop (Xvnc + Openbox), shown in the panel's Desktop page",
            exec: ["/bin/sh", SESSION],
            cwd: DESKTOP_HOME,
            // Started from the Desktop page; enable it on the Services page to start at boot.
            enabled,
            restart: "on-failure",
            restartSec: 3,
            restartLimit: 5,
            stopSignal: "SIGTERM",
            stopTimeout: 10,
        }, null, 2) + "\n");
        if (unitChanged) await agent("/daemon-reload", {}).catch(() => {});
        // A session started by an older script (one without the X cookie) must not stay up.
        if (sessionChanged && (await this.status())?.state === "running") await agent(`/units/${UNIT}/restart`, {}).catch(() => {});
    }

    static async status(): Promise<{ state: string; pid: number | null; error: string | null; enabled: boolean } | null> {
        return agent<{ state: string; pid: number | null; error: string | null; enabled: boolean }>(`/units/${UNIT}`).catch(() => null);
    }

    /**
     * Start the session if needed and wait for its VNC socket. Setting the
     * desktop up again first (session script, MIME and image loader caches,
     * menu) is cheap and repairs installs made by older versions of kiwi.
     */
    static async start(apps: DesktopApp[] = []): Promise<void> {
        const st = await this.status();
        if (st?.state !== "running") {
            await this.provision(apps);
            await agent(`/units/${UNIT}/start`, {});
        }
        for (let i = 0; i < 100 && !existsSync(SOCKET); i++) await Bun.sleep(100);
        if (!existsSync(SOCKET)) throw new Error("The desktop did not start; see its logs on the Services page");
    }

    static async stop(): Promise<void> {
        bridges.closeAll();
        await agent(`/units/${UNIT}/stop`, {});
    }

    // ---- Bridge between the browser and the VNC socket ----

    static async connect(apps: DesktopApp[] = []): Promise<string> {
        if (!existsSync(SOCKET)) await this.start(apps);
        try {
            return await bridges.connect(SOCKET, `Too many desktop connections (max ${MAX_BRIDGES})`);
        } catch (e) {
            throw new Error(`Could not connect to the desktop: ${(e as Error).message}`);
        }
    }

    static exists(id: string): boolean {
        return bridges.exists(id);
    }

    static attach(id: string, listener: (chunk: Uint8Array | null) => void): () => void {
        return bridges.attach(id, listener);
    }

    static write(id: string, data: Uint8Array) {
        bridges.write(id, data);
    }

    static disconnect(id: string) {
        bridges.disconnect(id);
    }
}
