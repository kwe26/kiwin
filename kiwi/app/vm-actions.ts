"use server";

import { join } from "node:path";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/forms";
import { requireUser } from "@/lib/session";
import { IMAGES_DIR, KiwiVms, randomMac, validateVm, vmDir, type DiskBus, type DiskCache, type DiskFormat, type PortForward, type Vm, type VmDisk } from "@/lib/vms";

// Server actions for the Virtual Machines page. Every field is read here and
// handed to KiwiVms.validateVm/create/update, which is the only place that
// decides what a valid machine is.

const text = (fd: FormData, name: string) => String(fd.get(name) ?? "").trim();
const num = (fd: FormData, name: string) => Number(text(fd, name));
const on = (fd: FormData, name: string) => fd.get(name) !== null;
const fail = (message: string): ActionState => ({ ok: false, message });
const done = (message: string): ActionState => ({ ok: true, message });

const refresh = (name?: string) => {
    revalidatePath("/vms");
    revalidatePath("/vms/images");
    if (name) revalidatePath(`/vms/${name}`);
};

/**
 * Disks and forwarded ports come from repeated fields, one per row:
 * disk-file-<i>, forward-host-<i>… Rows the form removed simply aren't there.
 */
function disks(fd: FormData): VmDisk[] {
    const out: VmDisk[] = [];
    for (const key of [...fd.keys()].filter((k) => k.startsWith("disk-file-"))) {
        const i = key.slice("disk-file-".length);
        const file = text(fd, key);
        if (!file) continue;
        out.push({
            file,
            format: text(fd, `disk-format-${i}`) as DiskFormat,
            bus: text(fd, `disk-bus-${i}`) as DiskBus,
            cache: (text(fd, `disk-cache-${i}`) || "writeback") as DiskCache,
            discard: on(fd, `disk-discard-${i}`),
            ...(on(fd, `disk-readonly-${i}`) ? { readOnly: true } : {}),
        });
    }
    return out;
}

function forwards(fd: FormData): PortForward[] {
    const out: PortForward[] = [];
    for (const key of [...fd.keys()].filter((k) => k.startsWith("forward-host-"))) {
        const i = key.slice("forward-host-".length);
        if (!text(fd, key)) continue;
        out.push({
            proto: (text(fd, `forward-proto-${i}`) || "tcp") as "tcp" | "udp",
            host: Number(text(fd, key)),
            guest: num(fd, `forward-guest-${i}`),
        });
    }
    return out;
}

/** The machine's fields as the form sends them (name only matters when creating). */
function fromForm(fd: FormData): Partial<Vm> {
    const topology = on(fd, "topology");
    return {
        name: text(fd, "name"),
        description: text(fd, "description"),
        cpus: num(fd, "cpus"),
        sockets: topology ? num(fd, "sockets") : undefined,
        cores: topology ? num(fd, "cores") : undefined,
        threads: topology ? num(fd, "threads") : undefined,
        cpuModel: text(fd, "cpuModel"),
        memoryMb: num(fd, "memoryMb"),
        machine: text(fd, "machine") as Vm["machine"],
        firmware: text(fd, "firmware") as Vm["firmware"],
        kvm: on(fd, "kvm"),
        disks: disks(fd),
        iso: text(fd, "iso") || null,
        bootFrom: text(fd, "bootFrom") as Vm["bootFrom"],
        bootMenu: on(fd, "bootMenu"),
        vga: text(fd, "vga") as Vm["vga"],
        network: text(fd, "network") as Vm["network"],
        nicModel: text(fd, "nicModel") as Vm["nicModel"],
        mac: text(fd, "mac") || randomMac(),
        forwards: forwards(fd),
        rtc: text(fd, "rtc") as Vm["rtc"],
        usbTablet: on(fd, "usbTablet"),
        balloon: on(fd, "balloon"),
        rng: on(fd, "rng"),
        // One argument per line, so quoting never comes up.
        extraArgs: text(fd, "extraArgs").split("\n").map((l) => l.trim()).filter(Boolean),
        autostart: on(fd, "autostart"),
    };
}

/**
 * Create the machine and, when asked, its first disk image. The whole machine
 * is checked before anything is written, so a rejected form leaves no image
 * behind.
 */
export async function createVm(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const input = fromForm(fd);
    const sizeGb = num(fd, "diskSize");
    const name = String(input.name ?? "");
    try {
        // The disk the form asked for, named after the machine, in its directory.
        const format = (text(fd, "diskFormat") || "qcow2") as DiskFormat;
        const planned: VmDisk | null = sizeGb > 0
            ? {
                  file: join(vmDir(name), `${name}.${format}`),
                  format,
                  bus: (text(fd, "diskBus") || "virtio") as DiskBus,
                  cache: "writeback",
                  discard: format === "qcow2",
              }
            : null;
        const wanted = { ...input, disks: [...(input.disks ?? []), ...(planned ? [planned] : [])] };
        // Throws on anything wrong with the machine while nothing exists yet.
        validateVm(wanted);
        if (planned) KiwiVms.createDisk(planned.file, sizeGb, format);
        const vm = await KiwiVms.create(wanted);
        refresh(vm.name);
    } catch (e) {
        return fail((e as Error).message);
    }
    redirect(`/vms/${name}`);
}

export async function updateVm(name: string, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    try {
        const vm = await KiwiVms.update(name, fromForm(fd));
        const status = await KiwiVms.status(name).catch(() => null);
        refresh(name);
        return done(status?.state === "running" ? `Saved. ${vm.name} keeps running as it is until you restart it.` : "Saved");
    } catch (e) {
        return fail((e as Error).message);
    }
}

export type VmOp = "start" | "shutdown" | "force-stop" | "reset" | "pause" | "resume";

export async function vmOp(name: string, op: VmOp, _: ActionState, __: FormData): Promise<ActionState> {
    await requireUser();
    const run = {
        start: () => KiwiVms.start(name),
        shutdown: () => KiwiVms.shutdown(name),
        "force-stop": () => KiwiVms.forceStop(name),
        reset: () => KiwiVms.reset(name),
        pause: () => KiwiVms.pause(name),
        resume: () => KiwiVms.resume(name),
    }[op];
    const said = {
        start: "Starting",
        shutdown: "Asked the guest to shut down; it decides how long that takes",
        "force-stop": "Powered off",
        reset: "Reset",
        pause: "Paused",
        resume: "Resumed",
    }[op];
    try {
        await run();
    } catch (e) {
        return fail((e as Error).message);
    }
    refresh(name);
    return done(said);
}

export async function setVmAutostart(name: string, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const want = on(fd, "autostart");
    try {
        await KiwiVms.setAutostart(name, want);
    } catch (e) {
        return fail((e as Error).message);
    }
    refresh(name);
    return done(want ? "Starts with the server" : "Does not start with the server");
}

export async function deleteVm(name: string, _: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const withDisks = on(fd, "withDisks");
    try {
        await KiwiVms.remove(name, withDisks);
    } catch (e) {
        return fail((e as Error).message);
    }
    refresh(name);
    redirect("/vms");
}

// ---- Disk images ----

export async function createImage(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const name = text(fd, "file");
    const format = (text(fd, "format") || "qcow2") as DiskFormat;
    try {
        // A bare name lands in /www/vms/images; a path is taken as given.
        const file = name.startsWith("/") ? name : join(IMAGES_DIR, `${name}.${format}`);
        const made = KiwiVms.createDisk(file, num(fd, "sizeGb"), format);
        refresh();
        return done(`Created ${made}`);
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function resizeImage(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    try {
        KiwiVms.resizeDisk(text(fd, "file"), num(fd, "sizeGb"));
        refresh();
        return done("Resized. The guest still has to grow its partition and filesystem.");
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function deleteImage(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    try {
        KiwiVms.deleteDisk(text(fd, "file"));
        refresh();
        return done("Image deleted");
    } catch (e) {
        return fail((e as Error).message);
    }
}

export async function snapshotImage(_: ActionState, fd: FormData): Promise<ActionState> {
    await requireUser();
    const op = text(fd, "op") as "create" | "apply" | "delete";
    const file = text(fd, "file");
    const tag = text(fd, "tag");
    try {
        // Applying a snapshot rewrites the disk under a running guest's feet.
        for (const vm of KiwiVms.all()) {
            if (!vm.disks.some((d) => d.file === file)) continue;
            const status = await KiwiVms.status(vm.name).catch(() => null);
            if (status?.state === "running") throw new Error(`Stop the machine ${vm.name} first: it is using this image`);
        }
        KiwiVms.snapshot(file, op, tag);
        refresh();
        return done({ create: `Snapshot ${tag} taken`, apply: `Rolled back to ${tag}`, delete: `Snapshot ${tag} deleted` }[op]);
    } catch (e) {
        return fail((e as Error).message);
    }
}
