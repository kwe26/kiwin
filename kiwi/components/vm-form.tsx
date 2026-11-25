"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import type { DiskBus, DiskCache, PortForward, Vm, VmDisk } from "@/lib/vms";
import type { ActionState } from "@/components/forms";

// The create and edit forms for a machine. Both post every field, so one
// server action (vm-actions.ts fromForm) reads them the same way; rows for
// disks and forwarded ports are numbered, and a removed row is simply absent.

export interface VmFormLimits {
    cpus: number;
    memoryMb: number;
    kvm: boolean;
    uefi: boolean;
    /** Disk images already on your storage, offered for attaching. */
    images: string[];
    /** ISO files found under /www. */
    isos: string[];
}

const BUSES: { value: DiskBus; label: string }[] = [
    { value: "virtio", label: "VirtIO (fastest; needs guest drivers)" },
    { value: "sata", label: "SATA / IDE (works everywhere)" },
    { value: "nvme", label: "NVMe" },
    { value: "usb", label: "USB" },
];
const CACHES: { value: DiskCache; label: string }[] = [
    { value: "writeback", label: "writeback (fast, host page cache)" },
    { value: "none", label: "none (bypass the host cache)" },
    { value: "writethrough", label: "writethrough (safest, slowest)" },
    { value: "directsync", label: "directsync" },
    { value: "unsafe", label: "unsafe (ignores flushes: scratch machines only)" },
];
const VGAS: { value: Vm["vga"]; label: string }[] = [
    { value: "virtio", label: "VirtIO (modern guests)" },
    { value: "std", label: "Standard VGA (best compatibility)" },
    { value: "qxl", label: "QXL" },
    { value: "vmware", label: "VMware SVGA" },
    { value: "cirrus", label: "Cirrus (very old guests)" },
    { value: "none", label: "No display" },
];
const NICS: { value: Vm["nicModel"]; label: string }[] = [
    { value: "virtio-net-pci", label: "VirtIO (fastest; needs guest drivers)" },
    { value: "e1000", label: "Intel e1000 (works everywhere)" },
    { value: "e1000e", label: "Intel e1000e" },
    { value: "rtl8139", label: "Realtek RTL8139" },
    { value: "vmxnet3", label: "VMware vmxnet3" },
];
const CPU_MODELS = ["host", "max", "qemu64", "kvm64", "Haswell", "Broadwell", "Skylake-Client", "Skylake-Server", "EPYC", "Nehalem"];

/** A row of disks/forwards keeps its own key, so removing one doesn't renumber the others. */
let seq = 0;
const keyed = <T,>(items: T[]) => items.map((value) => ({ key: ++seq, value }));

export function VmForm({ action, vm, limits, submit }: {
    action: (state: ActionState, fd: FormData) => Promise<ActionState>;
    /** The machine being edited, or undefined when creating one. */
    vm?: Vm;
    limits: VmFormLimits;
    submit: string;
}) {
    const [disks, setDisks] = useState(() => keyed<VmDisk>(vm?.disks ?? []));
    const [forwards, setForwards] = useState(() => keyed<PortForward>(vm?.forwards ?? []));
    const [network, setNetwork] = useState(vm?.network ?? "user");
    const [firmware, setFirmware] = useState(vm?.firmware ?? (limits.uefi ? "uefi" : "bios"));
    const [topology, setTopology] = useState(!!(vm?.sockets || vm?.cores || vm?.threads));
    const [newDisk, setNewDisk] = useState(!vm);
    const [advanced, setAdvanced] = useState(false);

    return (
        <ActionForm action={action} className="stack">
            <section className="card stack">
                <h2>Machine</h2>
                <div className="grid form-grid">
                    {!vm && (
                        <label><span className="label-text">Name</span>
                            <input type="text" name="name" placeholder="debian13" required pattern="[a-z0-9][a-z0-9-]{0,30}" title="Lower-case letters, digits and dashes" autoCapitalize="none" spellCheck={false} autoFocus />
                        </label>
                    )}
                    <label><span className="label-text">Description <span className="opt">(optional)</span></span>
                        <input type="text" name="description" defaultValue={vm?.description} maxLength={200} placeholder="Build machine" />
                    </label>
                    <label><span className="label-text">vCPUs <span className="opt">(up to {limits.cpus})</span></span>
                        <input type="number" name="cpus" min={1} max={limits.cpus} defaultValue={vm?.cpus ?? Math.min(2, limits.cpus)} required />
                    </label>
                    <label><span className="label-text">Memory (MB) <span className="opt">(up to {limits.memoryMb})</span></span>
                        <input type="number" name="memoryMb" min={128} max={limits.memoryMb} step={128} defaultValue={vm?.memoryMb ?? Math.min(2048, limits.memoryMb)} required />
                    </label>
                </div>
                <label className="check">
                    <input type="checkbox" name="kvm" defaultChecked={vm ? vm.kvm : true} disabled={!limits.kvm} />
                    <span>KVM acceleration{limits.kvm ? "" : " — this server has no /dev/kvm, so machines are fully emulated"}</span>
                </label>
                <label className="check">
                    <input type="checkbox" name="autostart" defaultChecked={vm?.autostart} />
                    <span>Start this machine when the server starts</span>
                </label>
            </section>

            <section className="card stack">
                <h2>Disks</h2>
                {!vm && (
                    <div className="ssl-box">
                        <label className="check">
                            <input type="checkbox" checked={newDisk} onChange={(e) => setNewDisk(e.target.checked)} />
                            <span>Create a new disk image for this machine</span>
                        </label>
                        {newDisk && (
                            <div className="grid form-grid">
                                <label><span className="label-text">Size (GB)</span>
                                    <input type="number" name="diskSize" min={1} max={65536} defaultValue={20} />
                                </label>
                                <label><span className="label-text">Format</span>
                                    <select name="diskFormat" defaultValue="qcow2">
                                        <option value="qcow2">qcow2 (grows as it fills, snapshots)</option>
                                        <option value="raw">raw (plain, slightly faster)</option>
                                    </select>
                                </label>
                                <label><span className="label-text">Bus</span>
                                    <select name="diskBus" defaultValue="virtio">
                                        {BUSES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                                    </select>
                                </label>
                            </div>
                        )}
                    </div>
                )}
                {disks.map(({ key, value }) => (
                    <div key={key} className="ssl-box stack">
                        <div className="grid form-grid">
                            <label><span className="label-text">Image</span>
                                <input type="text" name={`disk-file-${key}`} defaultValue={value.file} list="vm-images" required pattern="/www/.+" title="A path under /www" spellCheck={false} />
                            </label>
                            <label><span className="label-text">Format</span>
                                <select name={`disk-format-${key}`} defaultValue={value.format}>
                                    <option value="qcow2">qcow2</option>
                                    <option value="raw">raw</option>
                                </select>
                            </label>
                            <label><span className="label-text">Bus</span>
                                <select name={`disk-bus-${key}`} defaultValue={value.bus}>
                                    {BUSES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                                </select>
                            </label>
                            <label><span className="label-text">Cache</span>
                                <select name={`disk-cache-${key}`} defaultValue={value.cache}>
                                    {CACHES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                                </select>
                            </label>
                        </div>
                        <div className="row">
                            <label className="check">
                                <input type="checkbox" name={`disk-discard-${key}`} defaultChecked={value.discard} />
                                <span>Pass TRIM through (a qcow2 shrinks again)</span>
                            </label>
                            <label className="check">
                                <input type="checkbox" name={`disk-readonly-${key}`} defaultChecked={value.readOnly} />
                                <span>Read-only</span>
                            </label>
                            <button type="button" className="btn btn-ghost" onClick={() => setDisks((d) => d.filter((x) => x.key !== key))}>
                                <Trash2 size={15} aria-hidden /> Remove
                            </button>
                        </div>
                    </div>
                ))}
                <datalist id="vm-images">{limits.images.map((i) => <option key={i} value={i} />)}</datalist>
                <div className="row">
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setDisks((d) => [...d, ...keyed<VmDisk>([{ file: "", format: "qcow2", bus: "virtio", cache: "writeback", discard: true }])])}
                    >
                        <Plus size={15} aria-hidden /> Attach an existing image
                    </button>
                </div>
            </section>

            <section className="card stack">
                <h2>Boot and firmware</h2>
                <div className="grid form-grid">
                    <label><span className="label-text">ISO <span className="opt">(CD/DVD, optional)</span></span>
                        <input type="text" name="iso" defaultValue={vm?.iso ?? ""} list="vm-isos" placeholder="/www/isos/debian.iso" pattern="(/www/.+)?" title="A path under /www" spellCheck={false} />
                        <datalist id="vm-isos">{limits.isos.map((i) => <option key={i} value={i} />)}</datalist>
                    </label>
                    <label><span className="label-text">Boot from</span>
                        <select name="bootFrom" defaultValue={vm?.bootFrom ?? "disk"}>
                            <option value="disk">Disk</option>
                            <option value="cdrom">CD/DVD (the ISO)</option>
                            <option value="network">Network (PXE)</option>
                        </select>
                    </label>
                    <label><span className="label-text">Firmware</span>
                        <select name="firmware" value={firmware} onChange={(e) => setFirmware(e.target.value as Vm["firmware"])}>
                            <option value="uefi" disabled={!limits.uefi}>UEFI (OVMF){limits.uefi ? "" : " — not installed"}</option>
                            <option value="bios">BIOS (SeaBIOS)</option>
                        </select>
                    </label>
                    <label><span className="label-text">Chipset</span>
                        <select name="machine" defaultValue={vm?.machine ?? "q35"}>
                            <option value="q35">q35 (modern: PCIe, AHCI)</option>
                            <option value="pc">i440fx (old guests)</option>
                        </select>
                    </label>
                </div>
                <label className="check">
                    <input type="checkbox" name="bootMenu" defaultChecked={vm?.bootMenu} />
                    <span>Show the boot menu at start (pick a device with F12)</span>
                </label>
                {firmware === "uefi" && (
                    <p className="hint">UEFI variables are kept per machine, so its boot entries survive restarts. Switching an installed guest between UEFI and BIOS usually stops it booting.</p>
                )}
            </section>

            <section className="card stack">
                <h2>Network</h2>
                <div className="grid form-grid">
                    <label><span className="label-text">Mode</span>
                        <select name="network" value={network} onChange={(e) => setNetwork(e.target.value as Vm["network"])}>
                            <option value="user">User-mode (the guest reaches out; forward ports to reach in)</option>
                            <option value="none">No network</option>
                        </select>
                    </label>
                    <label><span className="label-text">Adapter</span>
                        <select name="nicModel" defaultValue={vm?.nicModel ?? "virtio-net-pci"} disabled={network === "none"}>
                            {NICS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
                        </select>
                    </label>
                    <label><span className="label-text">MAC address</span>
                        <input type="text" name="mac" defaultValue={vm?.mac} placeholder="(generated)" pattern="([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}|" title="aa:bb:cc:dd:ee:ff" spellCheck={false} />
                    </label>
                </div>
                {network === "user" && (
                    <>
                        <p className="hint">
                            User-mode networking needs no privileges on this server, and the guest is not reachable from outside unless you forward a port. A forwarded port is opened on
                            this server by QEMU itself, so allow it in the Firewall too if one is on.
                        </p>
                        {forwards.map(({ key, value }) => (
                            <div key={key} className="row">
                                <label><span className="label-text">Protocol</span>
                                    <select name={`forward-proto-${key}`} defaultValue={value.proto}>
                                        <option value="tcp">TCP</option>
                                        <option value="udp">UDP</option>
                                    </select>
                                </label>
                                <label><span className="label-text">This server</span>
                                    <input type="number" name={`forward-host-${key}`} min={1024} max={65535} defaultValue={value.host || ""} required />
                                </label>
                                <label><span className="label-text">In the machine</span>
                                    <input type="number" name={`forward-guest-${key}`} min={1} max={65535} defaultValue={value.guest || ""} required />
                                </label>
                                <button type="button" className="btn btn-ghost" onClick={() => setForwards((f) => f.filter((x) => x.key !== key))}>
                                    <Trash2 size={15} aria-hidden /> Remove
                                </button>
                            </div>
                        ))}
                        <div className="row">
                            <button type="button" className="btn btn-secondary" onClick={() => setForwards((f) => [...f, ...keyed<PortForward>([{ proto: "tcp", host: 0, guest: 0 }])])}>
                                <Plus size={15} aria-hidden /> Forward a port
                            </button>
                        </div>
                    </>
                )}
            </section>

            <section className="card stack">
                <h2>Display and devices</h2>
                <div className="grid form-grid">
                    <label><span className="label-text">Display adapter</span>
                        <select name="vga" defaultValue={vm?.vga ?? "virtio"}>
                            {VGAS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                        </select>
                    </label>
                    <label><span className="label-text">Clock</span>
                        <select name="rtc" defaultValue={vm?.rtc ?? "utc"}>
                            <option value="utc">UTC (Linux guests)</option>
                            <option value="localtime">Local time (Windows guests)</option>
                        </select>
                    </label>
                </div>
                <label className="check">
                    <input type="checkbox" name="usbTablet" defaultChecked={vm ? vm.usbTablet : true} />
                    <span>USB tablet pointer — keeps the mouse in step with the console</span>
                </label>
                <label className="check">
                    <input type="checkbox" name="balloon" defaultChecked={vm ? vm.balloon : true} />
                    <span>Memory balloon — the guest can give unused memory back</span>
                </label>
                <label className="check">
                    <input type="checkbox" name="rng" defaultChecked={vm ? vm.rng : true} />
                    <span>VirtIO RNG — the guest gets entropy from this server</span>
                </label>
            </section>

            <section className="card stack">
                <div className="row">
                    <h2>Advanced</h2>
                    <button type="button" className="btn btn-ghost" onClick={() => setAdvanced((a) => !a)}>{advanced ? "Hide" : "Show"}</button>
                </div>
                {advanced && (
                    <>
                        <div className="grid form-grid">
                            <label><span className="label-text">CPU model</span>
                                <input type="text" name="cpuModel" defaultValue={vm?.cpuModel ?? "host"} list="vm-cpus" pattern="[A-Za-z0-9_.,=+-]{1,64}" spellCheck={false} />
                                <datalist id="vm-cpus">{CPU_MODELS.map((c) => <option key={c} value={c} />)}</datalist>
                            </label>
                        </div>
                        <p className="hint"><code>host</code> passes this server&apos;s CPU through and is the fastest; it needs KVM, so without it <code>max</code> is used instead. Flags can be added with commas, e.g. <code>host,-vmx</code>.</p>
                        <label className="check">
                            <input type="checkbox" name="topology" checked={topology} onChange={(e) => setTopology(e.target.checked)} />
                            <span>Set the CPU topology by hand</span>
                        </label>
                        {topology && (
                            <>
                                <div className="grid form-grid">
                                    <label><span className="label-text">Sockets</span><input type="number" name="sockets" min={1} max={limits.cpus} defaultValue={vm?.sockets ?? 1} /></label>
                                    <label><span className="label-text">Cores</span><input type="number" name="cores" min={1} max={limits.cpus} defaultValue={vm?.cores ?? vm?.cpus ?? 2} /></label>
                                    <label><span className="label-text">Threads</span><input type="number" name="threads" min={1} max={limits.cpus} defaultValue={vm?.threads ?? 1} /></label>
                                </div>
                                <p className="hint">Sockets x cores x threads has to equal the vCPU count. Windows licensing counts sockets, so one socket with many cores is usually what you want.</p>
                            </>
                        )}
                        <label><span className="label-text">Extra QEMU arguments <span className="opt">(one per line)</span></span>
                            <textarea name="extraArgs" rows={4} defaultValue={(vm?.extraArgs ?? []).join("\n")} spellCheck={false} placeholder={"-device\nvirtio-serial-pci"} />
                        </label>
                        <p className="hint">Appended to the command line as given, one argument per line (so an option and its value are two lines). The machine&apos;s page shows the full command.</p>
                    </>
                )}
            </section>

            <div className="row"><SubmitButton>{submit}</SubmitButton></div>
        </ActionForm>
    );
}
