import { existsSync } from "node:fs";
import { apiGuard } from "@/lib/api";
import { KiwiDesktop } from "@/lib/desktop";
import { KiwiSoftware } from "@/lib/software";

/** Start the desktop if needed and open a VNC connection: -> { id } */
export async function POST(req: Request) {
    const denied = await apiGuard(req, { mutating: true });
    if (denied) return denied;
    if (!KiwiDesktop.isInstalled()) return Response.json({ error: "Install X.org Interface from Software first" }, { status: 409 });
    try {
        // X.org installs from older kiwi versions lack the GSettings schema compiler GTK's dialogs need.
        // Repaired in the background (it may download package lists); the next desktop start picks it up.
        const g = globalThis as { __kiwiXorgRepair?: Promise<unknown> };
        if (!existsSync("/www/softwares/xorg/current/root/usr/bin/glib-compile-schemas") && !g.__kiwiXorgRepair) {
            g.__kiwiXorgRepair = KiwiSoftware.repair("xorg").catch(() => {}).finally(() => { g.__kiwiXorgRepair = undefined; });
        }
        return Response.json({ id: await KiwiDesktop.connect(KiwiSoftware.desktopApps()) });
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 503 });
    }
}
