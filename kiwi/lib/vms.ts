import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { cpus, totalmem } from "node:os";
import { agent } from "./host";
import { SocketBridges } from "./socket-bridge";
import { KiwiSoftware, portsInUse, SOFTWARE_BIN, SOFTWARE_DIR, SOFTWARE_PATH } from "./software";

// Virtual machines: QEMU (installed from Software onto user.img) run as isol
// units, one per machine, shown in the panel's Virtual Machines page.
//
//   /www/softwares/qemu/current/root   QEMU's files, from Ubuntu's packages
//   /www/vms/<name>/vm.json            the machine's definition (this file's Vm)
//   /www/vms/<name>/*.qcow2            its disks, unless they live elsewhere in /www
//   /www/vms/<name>/uefi-vars.fd       UEFI variables (firmware "uefi"), per machine
//   /www/vms/<name>/serial.log         the guest's serial console
//   /www/services/vm-<name>.json       its isol unit
//   /run/kiwi-vms/<name>/vnc.sock      QEMU's VNC socket (root only, no VNC port)
//   /run/kiwi-vms/<name>/qmp.sock      QEMU's monitor, for shutdown/reset/pause
//
// Nothing is exposed to the network except the ports a machine forwards on
// purpose: the display travels over the panel's own connection (see
// lib/socket-bridge.ts), behind your login.

export const QEMU_ID = "qemu";
const QEMU_ROOT = join(SOFTWARE_DIR, QEMU_ID, "current/root");
const QEMU = join(SOFTWARE_BIN, "qemu-system-x86_64");
const QEMU_IMG = join(SOFTWARE_BIN, "qemu-img");
export const VMS_DIR = "/www/vms";
/** Images that belong to no single machine (the Disk images page creates them here). */
export const IMAGES_DIR = "/www/vms/images";
const RUN_DIR = "/run/kiwi-vms";
const MAX_CONSOLES = 4;
/** OVMF (UEFI) firmware from the ovmf package, with the pre-4M name as a fallback. */
const OVMF_CODE = ["usr/share/OVMF/OVMF_CODE_4M.fd", "usr/share/OVMF/OVMF_CODE.fd"];
const OVMF_VARS = ["usr/share/OVMF/OVMF_VARS_4M.fd", "usr/share/OVMF/OVMF_VARS.fd"];

export const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** Disk and ISO paths stay on your storage, so a machine can never read the system image. */
const INSIDE_WWW = /^\/www\/[^\0]*$/;

export type DiskFormat = "qcow2" | "raw";
export type DiskBus = "virtio" | "sata" | "nvme" | "usb";
export type NicModel = "virtio-net-pci" | "e1000" | "e1000e" | "rtl8139" | "vmxnet3";
export type Vga = "virtio" | "std" | "qxl" | "vmware" | "cirrus" | "none";
export type Firmware = "bios" | "uefi";
export type Machine = "q35" | "pc";
export type BootFrom = "disk" | "cdrom" | "network";
export type DiskCache = "writeback" | "none" | "writethrough" | "directsync" | "unsafe";

export interface VmDisk {
    /** Absolute path under /www. */
    file: string;
    format: DiskFormat;
    bus: DiskBus;
    cache: DiskCache;
    /** Pass the guest's TRIM through to the image, so a sparse qcow2 shrinks again. */
    discard: boolean;
    readOnly?: boolean;
}

export interface PortForward {
    proto: "tcp" | "udp";
    /** Port on this server. */
    host: number;
    /** Port inside the machine. */
    guest: number;
}

export interface Vm {
    name: string;
    description: string;
    /** vCPUs; topology is derived unless sockets/cores/threads are set. */
    cpus: number;
    sockets?: number;
    cores?: number;
    threads?: number;
    /** "host" passes this server's CPU through (fastest); "max" is the richest emulated one. */
    cpuModel: string;
    memoryMb: number;
    machine: Machine;
    firmware: Firmware;
    /** KVM acceleration; falsy, or no /dev/kvm, means TCG emulation (much slower). */
    kvm: boolean;
    disks: VmDisk[];
    /** An ISO under /www to boot or install from. */
    iso: string | null;
    bootFrom: BootFrom;
    /** Show QEMU's boot menu, so you can pick a device at start. */
    bootMenu: boolean;
    vga: Vga;
    /** User-mode networking (no host privileges needed) or no network at all. */
    network: "user" | "none";
    nicModel: NicModel;
    mac: string;
    /** Ports of this server that reach into the machine (user-mode networking only). */
    forwards: PortForward[];
    rtc: "utc" | "localtime";
    /** An absolute pointer: without it the mouse in the console drifts. */
    usbTablet: boolean;
    balloon: boolean;
    rng: boolean;
    /** Extra qemu-system-x86_64 arguments, appended as given. */
    extraArgs: string[];
    /** Start with the isolation. */
    autostart: boolean;
    createdAt: number;
}

export interface VmStatus {
    name: string;
    /** From its isol unit: stopped / running / failed … */
    state: string;
    /** From QEMU's monitor: "running", "paused", "shutdown"… null when it isn't up. */
    runState: string | null;
    pid: number | null;
    uptime: number | null;
    enabled: boolean;
    error: string | null;
}

export interface ImageInfo {
    file: string;
    format: string;
    /** Size the guest sees. */
    virtualSize: number;
    /** Space it takes on your storage right now. */
    actualSize: number;
    snapshots: { id: string; name: string; date: string; vmStateSize: number }[];
}

const consoles = new SocketBridges("vms", MAX_CONSOLES);

const unitName = (name: string) => `vm-${name}`;
const unitFile = (name: string) => `/www/services/${unitName(name)}.json`;
export const vmDir = (name: string) => join(VMS_DIR, name);
const runDir = (name: string) => join(RUN_DIR, name);
const vncSocket = (name: string) => join(runDir(name), "vnc.sock");
const qmpSocket = (name: string) => join(runDir(name), "qmp.sock");

/** A path the packages put somewhere between releases: the first one that exists. */
const inRoot = (candidates: string[]): string | null => candidates.map((c) => join(QEMU_ROOT, c)).find(existsSync) ?? null;

/** QEMU option values are comma-separated; a comma inside one is written twice. */
const opt = (v: string | number | boolean) => String(v).replaceAll(",", ",,");

export function randomMac(): string {
    // 52:54:00 is QEMU's own prefix, so a guest's drivers recognise it.
    const b = randomBytes(3);
    return `52:54:00:${[...b].map((n) => n.toString(16).padStart(2, "0")).join(":")}`;
}

function readJson<T>(file: string): T | null {
    try {
        return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
        return null;
    }
}

function writeJson(file: string, value: unknown, mode = 0o644) {
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode });
    renameSync(`${file}.tmp`, file);
}

// ---- QEMU's monitor (QMP) ---------------------------------------------------

/**
 * One QMP command on a fresh connection: greeting, qmp_capabilities, then the
 * command. QEMU answers in order, so replies line up with what we sent; events
 * can arrive in between and are ignored.
 */
async function qmp<T = unknown>(name: string, command: string, args?: Record<string, unknown>, timeoutMs = 5000): Promise<T> {
    const socket = qmpSocket(name);
    if (!existsSync(socket)) throw new Error(`${name} is not running`);
    const waiting: { resolve: (v: any) => void; reject: (e: Error) => void }[] = [];
    let buffer = "";
    let conn: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    const fail = (e: Error) => {
        while (waiting.length) waiting.shift()!.reject(e);
    };
    try {
        conn = await Bun.connect({
            unix: socket,
            socket: {
                data(_s, chunk) {
                    buffer += chunk.toString();
                    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
                        const line = buffer.slice(0, nl).trim();
                        buffer = buffer.slice(nl + 1);
                        if (!line) continue;
                        const msg = JSON.parse(line) as { QMP?: unknown; event?: string; return?: unknown; error?: { desc?: string } };
                        if (msg.QMP !== undefined || msg.event !== undefined) continue;
                        const next = waiting.shift();
                        if (!next) continue;
                        if (msg.error) next.reject(new Error(msg.error.desc ?? "QEMU rejected the command"));
                        else next.resolve(msg.return);
                    }
                },
                close: () => fail(new Error("QEMU closed the monitor")),
                error: (_s, e) => fail(e as Error),
            },
        });
        const send = <R>(execute: string, a?: Record<string, unknown>): Promise<R> => {
            const p = new Promise<R>((resolve, reject) => waiting.push({ resolve, reject }));
            conn!.write(JSON.stringify(a ? { execute, arguments: a } : { execute }) + "\n");
            return p;
        };
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${name} did not answer its monitor`)), timeoutMs).unref?.(),
        );
        return await Promise.race([
            (async () => {
                await send("qmp_capabilities");
                return send<T>(command, args);
            })(),
            timeout,
        ]);
    } finally {
        try {
            conn?.end();
        } catch {}
    }
}

// ---- The QEMU command line --------------------------------------------------

/**
 * The argv for a machine. Everything is explicit, so what runs is what the
 * page shows (the page prints this list).
 */
export function qemuArgs(vm: Vm, opts: { kvm?: boolean } = {}): string[] {
    const kvm = vm.kvm && (opts.kvm ?? KiwiVms.kvmAvailable());
    const dir = vmDir(vm.name);
    const a: string[] = [
        "-name", vm.name,
        "-machine", `type=${vm.machine},accel=${kvm ? "kvm" : "tcg"}`,
        // "host" needs KVM; emulated it is not a CPU QEMU can present.
        "-cpu", kvm ? vm.cpuModel : vm.cpuModel === "host" ? "max" : vm.cpuModel,
        "-m", String(vm.memoryMb),
    ];
    const topology = [
        ["sockets", vm.sockets],
        ["cores", vm.cores],
        ["threads", vm.threads],
    ].filter(([, v]) => !!v).map(([k, v]) => `${k}=${v}`);
    a.push("-smp", [`cpus=${vm.cpus}`, ...topology].join(","));

    if (vm.firmware === "uefi") {
        const code = inRoot(OVMF_CODE);
        if (!code) throw new Error("UEFI firmware (OVMF) is missing from the QEMU install; reinstall it from Software or use BIOS");
        // The variables file is per machine and writable: it holds the boot entries.
        a.push("-drive", `if=pflash,format=raw,unit=0,readonly=on,file=${opt(code)}`);
        a.push("-drive", `if=pflash,format=raw,unit=1,file=${opt(join(dir, "uefi-vars.fd"))}`);
    }

    vm.disks.forEach((d, i) => {
        const id = `disk${i}`;
        const common = [
            `file=${opt(d.file)}`,
            `format=${d.format}`,
            `cache=${d.cache}`,
            ...(d.discard ? ["discard=unmap"] : []),
            ...(d.readOnly ? ["readonly=on"] : []),
        ];
        if (d.bus === "virtio" || d.bus === "sata") {
            // if=virtio is virtio-blk; if=ide on q35 lands on its AHCI (SATA) controller.
            a.push("-drive", [...common, `if=${d.bus === "virtio" ? "virtio" : "ide"}`, `index=${i}`].join(","));
        } else {
            a.push("-drive", [...common, "if=none", `id=${id}`].join(","));
            a.push("-device", d.bus === "nvme" ? `nvme,drive=${id},serial=${id}` : `usb-storage,drive=${id}`);
        }
    });

    if (vm.iso) {
        a.push("-drive", `file=${opt(vm.iso)},media=cdrom,if=ide,index=${vm.disks.length},readonly=on`);
    }

    const bootDevice = { disk: "c", cdrom: "d", network: "n" }[vm.bootFrom];
    a.push("-boot", `order=${bootDevice},menu=${vm.bootMenu ? "on" : "off"}`);

    if (vm.network === "user") {
        const forwards = vm.forwards.map((f) => `hostfwd=${f.proto}::${f.host}-:${f.guest}`);
        a.push("-netdev", ["user", "id=net0", ...forwards].join(","));
        a.push("-device", `${vm.nicModel},netdev=net0,mac=${vm.mac}`);
    } else {
        a.push("-nic", "none");
    }

    // The display: a VNC server on a socket in a root-only directory, no port.
    a.push("-vga", vm.vga);
    a.push("-vnc", `unix:${vncSocket(vm.name)}`);
    // usb-storage and usb-tablet both need a controller; q35 has none by default.
    if (vm.usbTablet || vm.disks.some((d) => d.bus === "usb")) a.push("-usb");
    if (vm.usbTablet) a.push("-device", "usb-tablet");

    a.push("-rtc", `base=${vm.rtc}`);
    if (vm.balloon) a.push("-device", "virtio-balloon");
    if (vm.rng) a.push("-object", "rng-random,filename=/dev/urandom,id=rng0", "-device", "virtio-rng-pci,rng=rng0");

    // The monitor kiwi drives (shutdown, reset, pause), and the guest's serial log.
    a.push("-qmp", `unix:${qmpSocket(vm.name)},server=on,wait=off`);
    a.push("-serial", `file:${join(dir, "serial.log")}`);
    // No window to open and no stdin: it runs as a service. (Not -nographic,
    // which would send the serial line and the monitor to stdio instead.)
    a.push("-display", "none", "-monitor", "none");
    a.push(...vm.extraArgs);
    return a;
}

// ---- Definitions ------------------------------------------------------------

const DEFAULTS: Omit<Vm, "name" | "mac" | "createdAt"> = {
    description: "",
    cpus: 2,
    cpuModel: "host",
    memoryMb: 2048,
    machine: "q35",
    firmware: "uefi",
    kvm: true,
    disks: [],
    iso: null,
    bootFrom: "disk",
    bootMenu: false,
    vga: "virtio",
    network: "user",
    nicModel: "virtio-net-pci",
    forwards: [],
    rtc: "utc",
    usbTablet: true,
    balloon: true,
    rng: true,
    extraArgs: [],
    autostart: false,
};

const INT = (v: unknown, name: string, lo: number, hi: number): number => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}`);
    return n;
};

const oneOf = <T extends string>(v: unknown, name: string, allowed: readonly T[]): T => {
    if (!allowed.includes(v as T)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
    return v as T;
};

/** A path on your storage, with no way out of it. */
function wwwPath(p: unknown, what: string): string {
    const s = String(p ?? "").trim();
    if (!INSIDE_WWW.test(s) || s.includes("/../") || s.endsWith("/..")) throw new Error(`${what} must be a path under /www`);
    return s;
}

/** Check and normalise a machine from the form, keeping `base`'s fields where the form has none. */
export function validateVm(input: Partial<Vm>, base?: Vm): Vm {
    const name = base?.name ?? String(input.name ?? "").trim();
    if (!NAME.test(name)) throw new Error("The name must be lower-case letters, digits or dashes (max 31 characters)");
    const prev = base ?? { ...DEFAULTS, name, mac: randomMac(), createdAt: Date.now() };
    const take = <K extends keyof Vm>(k: K): Vm[K] => (input[k] === undefined ? prev[k] : (input[k] as Vm[K]));

    const host = KiwiVms.hostLimits();
    const cpus = INT(take("cpus"), "vCPUs", 1, host.cpus);
    const memoryMb = INT(take("memoryMb"), "Memory", 128, host.memoryMb);
    const disks = (take("disks") as VmDisk[]).map((d, i) => ({
        file: wwwPath(d.file, `Disk ${i + 1}`),
        format: oneOf(d.format, "Disk format", ["qcow2", "raw"] as const),
        bus: oneOf(d.bus, "Disk bus", ["virtio", "sata", "nvme", "usb"] as const),
        cache: oneOf(d.cache ?? "writeback", "Disk cache", ["writeback", "none", "writethrough", "directsync", "unsafe"] as const),
        discard: !!d.discard,
        ...(d.readOnly ? { readOnly: true } : {}),
    }));
    if (disks.length > 8) throw new Error("At most 8 disks");
    const iso = input.iso === undefined ? prev.iso : input.iso ? wwwPath(input.iso, "The ISO") : null;
    const forwards = (take("forwards") as PortForward[]).map((f) => ({
        proto: oneOf(f.proto, "Forward protocol", ["tcp", "udp"] as const),
        host: INT(f.host, "Forwarded port on this server", 1024, 65535),
        guest: INT(f.guest, "Forwarded port in the machine", 1, 65535),
    }));
    if (forwards.length > 16) throw new Error("At most 16 forwarded ports");
    // QEMU binds a forwarded port on this server itself (the isolation shares
    // its network), so a port the panel, SSH or a website already holds would
    // only fail at start, with a message nobody sees. Ports this machine
    // already forwards are its own: it is holding them while being edited.
    const mine = new Set((base?.forwards ?? []).map((f) => f.host));
    const listening = portsInUse();
    const taken = new Set<number>();
    for (const f of forwards) {
        if (taken.has(f.host)) throw new Error(`Port ${f.host} is forwarded twice`);
        taken.add(f.host);
        if (!mine.has(f.host) && listening.has(f.host)) {
            throw new Error(`Port ${f.host} on this server is already in use; pick another one to forward`);
        }
    }
    const mac = String(take("mac"));
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) throw new Error("The MAC address looks wrong");
    const cpuModel = String(take("cpuModel"));
    if (!/^[A-Za-z0-9_.,=+-]{1,64}$/.test(cpuModel)) throw new Error("The CPU model looks wrong");
    // Each part is optional; given any, they have to multiply out to the vCPU count.
    const part = (k: "sockets" | "cores" | "threads", label: string) => {
        const v = input[k] === undefined ? prev[k] : input[k];
        return v ? INT(v, label, 1, cpus) : undefined;
    };
    const topology = { sockets: part("sockets", "Sockets"), cores: part("cores", "Cores"), threads: part("threads", "Threads") };

    const vm: Vm = {
        name,
        description: String(take("description") ?? "").slice(0, 200),
        cpus,
        sockets: topology.sockets,
        cores: topology.cores,
        threads: topology.threads,
        cpuModel,
        memoryMb,
        machine: oneOf(take("machine"), "Machine type", ["q35", "pc"] as const),
        firmware: oneOf(take("firmware"), "Firmware", ["bios", "uefi"] as const),
        kvm: !!take("kvm"),
        disks,
        iso,
        bootFrom: oneOf(take("bootFrom"), "Boot from", ["disk", "cdrom", "network"] as const),
        bootMenu: !!take("bootMenu"),
        vga: oneOf(take("vga"), "Display adapter", ["virtio", "std", "qxl", "vmware", "cirrus", "none"] as const),
        network: oneOf(take("network"), "Network", ["user", "none"] as const),
        nicModel: oneOf(take("nicModel"), "Network adapter", ["virtio-net-pci", "e1000", "e1000e", "rtl8139", "vmxnet3"] as const),
        mac,
        forwards,
        rtc: oneOf(take("rtc"), "Clock", ["utc", "localtime"] as const),
        usbTablet: !!take("usbTablet"),
        balloon: !!take("balloon"),
        rng: !!take("rng"),
        extraArgs: (take("extraArgs") as string[]).map((s) => String(s)).filter(Boolean).slice(0, 64),
        autostart: !!take("autostart"),
        createdAt: prev.createdAt,
    };
    if (topology.sockets || topology.cores || topology.threads) {
        const product = (topology.sockets ?? 1) * (topology.cores ?? 1) * (topology.threads ?? 1);
        if (product !== cpus) throw new Error(`Sockets x cores x threads (${product}) must equal the ${cpus} vCPUs`);
    }
    if (vm.bootFrom === "cdrom" && !vm.iso) throw new Error("Booting from CD/DVD needs an ISO");
    if (vm.network === "none" && vm.forwards.length) throw new Error("Forwarded ports need user-mode networking");
    return vm;
}

export class KiwiVms {
    static isInstalled(): boolean {
        return existsSync(join(QEMU_ROOT, "usr/bin/qemu-system-x86_64"));
    }

    /** KVM acceleration is possible: the host has /dev/kvm and kiwin bound it in. */
    static kvmAvailable(): boolean {
        return existsSync("/dev/kvm");
    }

    static hasUefi(): boolean {
        return !!inRoot(OVMF_CODE);
    }

    static version(): string | null {
        return KiwiSoftware.current(QEMU_ID);
    }

    /** What this server can give a machine. */
    static hostLimits(): { cpus: number; memoryMb: number } {
        // Leave the panel, the database and the websites something to run in.
        return { cpus: Math.max(1, cpus().length), memoryMb: Math.max(256, Math.floor(totalmem() / 1024 / 1024) - 512) };
    }

    static names(): string[] {
        try {
            return readdirSync(VMS_DIR, { withFileTypes: true })
                .filter((e) => e.isDirectory() && NAME.test(e.name) && existsSync(join(VMS_DIR, e.name, "vm.json")))
                .map((e) => e.name)
                .sort();
        } catch {
            return [];
        }
    }

    static get(name: string): Vm | null {
        if (!NAME.test(name)) return null;
        const vm = readJson<Vm>(join(vmDir(name), "vm.json"));
        return vm ? { ...DEFAULTS, ...vm, name } : null;
    }

    static all(): Vm[] {
        return this.names().map((n) => this.get(n)).filter((v): v is Vm => !!v);
    }

    /** Unit state of every machine, in one agent call. */
    static async statuses(): Promise<Record<string, VmStatus>> {
        const units = await agent<{ name: string; state: string; pid: number | null; uptime: number | null; enabled: boolean; error: string | null }[]>("/units").catch(() => []);
        const byName = new Map(units.map((u) => [u.name, u]));
        const out: Record<string, VmStatus> = {};
        for (const name of this.names()) {
            const u = byName.get(unitName(name));
            const status: VmStatus = {
                name,
                state: u?.state ?? "stopped",
                runState: null,
                pid: u?.pid ?? null,
                uptime: u?.uptime ?? null,
                enabled: !!u?.enabled,
                error: u?.error ?? null,
            };
            if (status.state === "running") {
                status.runState = await qmp<{ status: string }>(name, "query-status")
                    .then((r) => r.status)
                    .catch(() => null);
            }
            out[name] = status;
        }
        return out;
    }

    static async status(name: string): Promise<VmStatus> {
        const vm = this.get(name);
        if (!vm) throw new Error(`No machine named ${name}`);
        return (await this.statuses())[name];
    }

    // ---- Definition and unit ----

    /**
     * Write a machine's definition and its unit. The unit is rewritten from the
     * definition every time, so edits reach the next start; `autostart` is the
     * unit's `enabled`.
     */
    static async save(vm: Vm): Promise<void> {
        if (!this.isInstalled()) throw new Error("QEMU is not installed");
        const dir = vmDir(vm.name);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (vm.firmware === "uefi") this.seedUefiVars(vm.name);
        // Fails here (instead of at start) when the machine asks for something QEMU can't do.
        const args = qemuArgs(vm);
        writeJson(join(dir, "vm.json"), vm, 0o600);
        mkdirSync("/www/services", { recursive: true, mode: 0o755 });
        writeJson(unitFile(vm.name), {
            description: `${vm.description || `Virtual machine ${vm.name}`} (QEMU${vm.kvm && this.kvmAvailable() ? "/KVM" : ""})`,
            // The sockets live on a tmpfs, so the directory is made on every start.
            pre: [`mkdir -p ${runDir(vm.name)} && chmod 700 ${runDir(vm.name)} && rm -f ${vncSocket(vm.name)} ${qmpSocket(vm.name)}`],
            exec: [QEMU, ...args],
            cwd: dir,
            env: { PATH: SOFTWARE_PATH },
            enabled: vm.autostart,
            // A machine that powered itself off stays off; only a crash is retried.
            restart: "no",
            stopSignal: "SIGTERM",
            stopTimeout: 30,
            // Not read by the agent: lets the panel link a unit back to its machine.
            kiwi: { vm: vm.name },
        });
        await agent("/daemon-reload", {});
    }

    /** UEFI variables are per machine: copy the template once, then leave it alone. */
    private static seedUefiVars(name: string) {
        const vars = join(vmDir(name), "uefi-vars.fd");
        if (existsSync(vars)) return;
        const template = inRoot(OVMF_VARS);
        if (!template) throw new Error("UEFI firmware (OVMF) is missing from the QEMU install; reinstall it from Software or use BIOS");
        copyFileSync(template, vars);
    }

    static async create(input: Partial<Vm>): Promise<Vm> {
        const vm = validateVm(input);
        if (existsSync(join(vmDir(vm.name), "vm.json"))) throw new Error(`A machine named ${vm.name} already exists`);
        await this.save(vm);
        return vm;
    }

    static async update(name: string, input: Partial<Vm>): Promise<Vm> {
        const current = this.get(name);
        if (!current) throw new Error(`No machine named ${name}`);
        const vm = validateVm(input, current);
        await this.save(vm);
        return vm;
    }

    /** Remove a machine, and its directory (disks included) when asked. */
    static async remove(name: string, withDisks: boolean): Promise<void> {
        const vm = this.get(name);
        if (!vm) throw new Error(`No machine named ${name}`);
        const status = await this.status(name).catch(() => null);
        if (status?.state === "running") throw new Error("Stop the machine first");
        rmSync(unitFile(name), { force: true });
        await agent("/daemon-reload", {}).catch(() => {});
        if (withDisks) rmSync(vmDir(name), { recursive: true, force: true });
        else rmSync(join(vmDir(name), "vm.json"), { force: true });
    }

    // ---- Running ----

    static async start(name: string): Promise<void> {
        const vm = this.get(name);
        if (!vm) throw new Error(`No machine named ${name}`);
        for (const d of vm.disks) {
            if (!existsSync(d.file)) throw new Error(`Its disk ${d.file} is missing`);
        }
        if (vm.iso && !existsSync(vm.iso)) throw new Error(`Its ISO ${vm.iso} is missing`);
        // Rewrite the unit first, so an edited machine starts as edited.
        await this.save(vm);
        await agent(`/units/${unitName(name)}/start`, {});
    }

    /** ACPI power button: the guest shuts itself down. */
    static async shutdown(name: string): Promise<void> {
        await qmp(name, "system_powerdown");
    }

    /** Pull the plug (the unit's SIGTERM makes QEMU exit at once). */
    static async forceStop(name: string): Promise<void> {
        await agent(`/units/${unitName(name)}/stop`, {});
    }

    static async reset(name: string): Promise<void> {
        await qmp(name, "system_reset");
    }

    static async pause(name: string): Promise<void> {
        await qmp(name, "stop");
    }

    static async resume(name: string): Promise<void> {
        await qmp(name, "cont");
    }

    static async setAutostart(name: string, on: boolean): Promise<void> {
        const vm = this.get(name);
        if (!vm) throw new Error(`No machine named ${name}`);
        await this.save({ ...vm, autostart: on });
    }

    static logs(name: string, lines = 80): Promise<string> {
        return fetch(`http://kiwin/units/${unitName(name)}/logs?lines=${lines}`, {
            unix: process.env.KIWIN_SOCKET ?? "/run/kiwin/ctl/agent.sock",
        } as RequestInit).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((t) => t.trimEnd());
    }

    /** The guest's serial console, as far back as the log goes. */
    static serial(name: string, bytes = 16384): string {
        const file = join(vmDir(name), "serial.log");
        let fd: number | null = null;
        try {
            const size = statSync(file).size;
            const start = Math.max(0, size - bytes);
            const buf = Buffer.alloc(Math.min(size, bytes));
            fd = openSync(file, "r");
            readSync(fd, buf, 0, buf.length, start);
            return buf.toString("utf8");
        } catch {
            return "";
        } finally {
            if (fd !== null) closeSync(fd);
        }
    }

    // ---- Disk images ----

    private static img(args: string[], what: string): string {
        const p = Bun.spawnSync([QEMU_IMG, ...args], { stdout: "pipe", stderr: "pipe" });
        if (p.exitCode !== 0) throw new Error(`${what} failed: ${p.stderr.toString().trim().split("\n").pop() || `qemu-img exited ${p.exitCode}`}`);
        return p.stdout.toString();
    }

    static info(file: string): ImageInfo {
        const path = wwwPath(file, "The image");
        const raw = JSON.parse(this.img(["info", "--output=json", path], "Reading the image")) as {
            format: string;
            "virtual-size": number;
            "actual-size": number;
            snapshots?: { id: string; name: string; "date-sec": number; "vm-state-size": number }[];
        };
        return {
            file: path,
            format: raw.format,
            virtualSize: raw["virtual-size"],
            actualSize: raw["actual-size"] ?? 0,
            snapshots: (raw.snapshots ?? []).map((s) => ({
                id: s.id,
                name: s.name,
                date: new Date(s["date-sec"] * 1000).toISOString(),
                vmStateSize: s["vm-state-size"],
            })),
        };
    }

    /** Create a disk image. `sizeGb` is what the guest sees; qcow2 only takes what it uses. */
    static createDisk(file: string, sizeGb: number, format: DiskFormat): string {
        const path = wwwPath(file, "The image");
        if (existsSync(path)) throw new Error(`${path} already exists`);
        const size = INT(sizeGb, "Size", 1, 65536);
        mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
        this.img(["create", "-f", oneOf(format, "Format", ["qcow2", "raw"] as const), path, `${size}G`], "Creating the image");
        return path;
    }

    /** Grow an image. Shrinking is not offered: it cuts the end off the guest's filesystem. */
    static resizeDisk(file: string, sizeGb: number): void {
        const info = this.info(file);
        const size = INT(sizeGb, "Size", 1, 65536) * 1024 ** 3;
        if (size < info.virtualSize) throw new Error("An image can only grow: a smaller size would cut off the end of the guest's filesystem");
        if (size === info.virtualSize) throw new Error("That is its size already");
        this.img(["resize", info.file, String(size)], "Resizing the image");
    }

    static deleteDisk(file: string): void {
        const path = wwwPath(file, "The image");
        for (const vm of this.all()) {
            if (vm.disks.some((d) => d.file === path)) throw new Error(`${basename(path)} is attached to the machine ${vm.name}`);
        }
        rmSync(path, { force: true });
    }

    static snapshot(file: string, op: "create" | "apply" | "delete", tag: string): void {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(tag)) throw new Error("A snapshot name must be letters, digits, dots, dashes or underscores");
        const info = this.info(file);
        if (info.format !== "qcow2") throw new Error("Snapshots need a qcow2 image");
        const flag = { create: "-c", apply: "-a", delete: "-d" }[op];
        this.img(["snapshot", flag, tag, info.file], `The snapshot ${tag}`);
    }

    /**
     * Disk images: the ones in the machines' own directories, the shared
     * /www/vms/images, and anything a machine has attached from elsewhere.
     */
    static images(): string[] {
        const seen = new Set<string>();
        for (const dir of [IMAGES_DIR, VMS_DIR, ...this.names().map(vmDir)]) {
            let entries: { name: string; file: boolean }[] = [];
            try {
                entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, file: e.isFile() }));
            } catch {
                continue;
            }
            for (const e of entries) {
                if (e.file && /\.(qcow2|raw|img)$/i.test(e.name)) seen.add(join(dir, e.name));
            }
        }
        for (const vm of this.all()) for (const d of vm.disks) seen.add(d.file);
        return [...seen].sort();
    }

    /**
     * ISO files to offer as a CD/DVD: /www/isos (the obvious place), the
     * machines' own directories and the top of /www, one level deep each.
     */
    static isos(): string[] {
        const found = new Set<string>();
        for (const dir of ["/www/isos", "/www", VMS_DIR, ...this.names().map(vmDir)]) {
            let entries: { name: string; dir: boolean }[] = [];
            try {
                entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
            } catch {
                continue;
            }
            for (const e of entries) {
                if (!e.dir && /\.iso$/i.test(e.name)) found.add(join(dir, e.name));
            }
        }
        for (const vm of this.all()) if (vm.iso) found.add(vm.iso);
        return [...found].sort();
    }

    // ---- The console ----

    /** Open a VNC connection to a running machine: -> the bridge id. */
    static async connect(name: string): Promise<string> {
        const status = await this.status(name);
        if (status.state !== "running") throw new Error(`${name} is not running`);
        const socket = vncSocket(name);
        for (let i = 0; i < 50 && !existsSync(socket); i++) await Bun.sleep(100);
        if (!existsSync(socket)) throw new Error(`${name} has no display socket; check its logs`);
        try {
            return await consoles.connect(socket, `Too many open consoles (max ${MAX_CONSOLES})`);
        } catch (e) {
            throw new Error(`Could not connect to ${name}: ${(e as Error).message}`);
        }
    }

    static consoleExists(id: string): boolean {
        return consoles.exists(id);
    }

    static attach(id: string, listener: (chunk: Uint8Array | null) => void): () => void {
        return consoles.attach(id, listener);
    }

    static write(id: string, data: Uint8Array) {
        consoles.write(id, data);
    }

    static disconnect(id: string) {
        consoles.disconnect(id);
    }
}
