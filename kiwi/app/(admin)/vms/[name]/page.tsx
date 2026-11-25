import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { VmConsole } from "@/components/vm-console";
import { VmForm } from "@/components/vm-form";
import { formatBytes, formatUptime } from "@/lib/services";
import { requireUser } from "@/lib/session";
import { KiwiVms, qemuArgs, vmDir } from "@/lib/vms";
import { deleteVm, setVmAutostart, updateVm, vmOp } from "@/app/vm-actions";

type Props = { params: Promise<{ name: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    return { title: `${(await params).name} · Virtual Machines` };
}

export default async function VmPage({ params }: Props) {
    await requireUser();
    const { name } = await params;
    const vm = KiwiVms.get(name);
    if (!vm) notFound();

    const status = await KiwiVms.status(name).catch(() => null);
    const running = status?.state === "running";
    const paused = status?.runState === "paused";
    const logs = await KiwiVms.logs(name, 40).catch((e) => `Could not read its log: ${(e as Error).message}`);
    const serial = KiwiVms.serial(name, 8192);
    // What the unit actually runs, so nothing about the machine is hidden.
    let command: string[] = [];
    let commandError: string | null = null;
    try {
        command = qemuArgs(vm);
    } catch (e) {
        commandError = (e as Error).message;
    }
    const images = vm.disks.map((d) => {
        try {
            return { disk: d, info: KiwiVms.info(d.file), error: null };
        } catch (e) {
            return { disk: d, info: null, error: (e as Error).message };
        }
    });

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>{vm.name}</h1>
                    <p>
                        {vm.description ? `${vm.description} · ` : ""}
                        {vm.cpus} vCPU · {vm.memoryMb} MB · {vm.firmware === "uefi" ? "UEFI" : "BIOS"} · {vm.machine}
                        {vm.kvm && KiwiVms.kvmAvailable() ? " · KVM" : " · emulated (no KVM)"}
                        {running ? ` · up ${formatUptime(status?.uptime ?? null)}` : ""}
                    </p>
                </div>
                <div className="row">
                    {running ? (
                        <>
                            <ActionForm action={vmOp.bind(null, vm.name, paused ? "resume" : "pause")} className="inline-form">
                                <SubmitButton variant="secondary">{paused ? "Resume" : "Pause"}</SubmitButton>
                            </ActionForm>
                            <ActionForm action={vmOp.bind(null, vm.name, "reset")} className="inline-form">
                                <SubmitButton variant="secondary" confirm="Reset the machine? It is like pressing the reset button: the guest gets no warning.">Reset</SubmitButton>
                            </ActionForm>
                            <ActionForm action={vmOp.bind(null, vm.name, "shutdown")} className="inline-form">
                                <SubmitButton variant="secondary">Shut down</SubmitButton>
                            </ActionForm>
                            <ActionForm action={vmOp.bind(null, vm.name, "force-stop")} className="inline-form">
                                <SubmitButton variant="danger" confirm="Power off the machine? Unsaved work in the guest is lost, like pulling the plug.">Power off</SubmitButton>
                            </ActionForm>
                        </>
                    ) : (
                        <ActionForm action={vmOp.bind(null, vm.name, "start")} className="inline-form">
                            <SubmitButton>Start</SubmitButton>
                        </ActionForm>
                    )}
                    <Link href="/vms" className="btn btn-ghost">All machines</Link>
                </div>
            </div>

            {status?.error && <p className="notice notice-error" role="alert">{status.error}</p>}
            {commandError && <p className="notice notice-error" role="alert">{commandError}</p>}

            <section className="card stack">
                <h2>Screen</h2>
                <VmConsole name={vm.name} running={running && !paused} />
                <p className="hint">
                    The screen travels over this page&apos;s own connection, so it is never on the network. A guest without its own drivers may need the
                    Standard VGA adapter; with the USB tablet pointer off, the mouse will drift.
                </p>
            </section>

            <section className="card stack">
                <h2>Disks</h2>
                {!images.length ? (
                    <p className="hint">No disks attached. Add one below, or create an image on the <Link href="/vms/images">Disk images</Link> page.</p>
                ) : (
                    <table className="table">
                        <thead><tr><th>Image</th><th>Bus</th><th>Format</th><th>Guest sees</th><th>On disk</th><th>Snapshots</th></tr></thead>
                        <tbody>
                            {images.map(({ disk, info, error }) => (
                                <tr key={disk.file}>
                                    <td><code>{disk.file}</code>{error && <div className="hint">{error}</div>}</td>
                                    <td>{disk.bus}{disk.readOnly ? " (read-only)" : ""}</td>
                                    <td>{info?.format ?? disk.format}</td>
                                    <td>{info ? formatBytes(info.virtualSize) : "-"}</td>
                                    <td>{info ? formatBytes(info.actualSize) : "-"}</td>
                                    <td>{info?.snapshots.length ? info.snapshots.map((s) => s.name).join(", ") : "-"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <p className="hint">Its files live in <code>{vmDir(vm.name)}</code>. Snapshots are taken on the <Link href="/vms/images">Disk images</Link> page, while the machine is off.</p>
            </section>

            <section className="card stack">
                <h2>Settings</h2>
                {running && <p className="notice" role="status">The machine is running: saved changes apply the next time it starts.</p>}
                <VmForm
                    action={updateVm.bind(null, vm.name)}
                    vm={vm}
                    submit="Save settings"
                    limits={{ ...KiwiVms.hostLimits(), kvm: KiwiVms.kvmAvailable(), uefi: KiwiVms.hasUefi(), images: KiwiVms.images(), isos: KiwiVms.isos() }}
                />
            </section>

            <section className="card stack">
                <h2>Start with the server</h2>
                <ActionForm action={setVmAutostart.bind(null, vm.name)} className="inline-form">
                    <label className="check">
                        <input type="checkbox" name="autostart" defaultChecked={vm.autostart} />
                        <span>Start {vm.name} when the server starts</span>
                    </label>
                    <SubmitButton variant="secondary">Save</SubmitButton>
                </ActionForm>
            </section>

            <section className="card stack">
                <h2>Command line</h2>
                <p className="hint">What its service runs. Extra arguments from the settings are at the end.</p>
                <pre className="log">{command.length ? `qemu-system-x86_64 ${command.join(" ")}` : commandError}</pre>
            </section>

            <section className="card stack">
                <h2>Logs</h2>
                <p className="hint">QEMU&apos;s own output (its service is <code>vm-{vm.name}</code> on the Services page).</p>
                <pre className="log">{logs || "No output yet."}</pre>
                <h3>Serial console</h3>
                <p className="hint">The guest&apos;s serial line, written to <code>{vmDir(vm.name)}/serial.log</code>.</p>
                <pre className="log">{serial || "Nothing on the serial line. A guest has to be told to use it (for Linux, console=ttyS0)."}</pre>
            </section>

            <section className="card stack">
                <h2>Delete</h2>
                <ActionForm action={deleteVm.bind(null, vm.name)} className="stack">
                    <label className="check">
                        <input type="checkbox" name="withDisks" />
                        <span>Also delete <code>{vmDir(vm.name)}</code> and every disk image in it</span>
                    </label>
                    <div className="row">
                        <SubmitButton variant="danger" confirm={`Delete the machine ${vm.name}? This cannot be undone.`}>Delete machine</SubmitButton>
                    </div>
                </ActionForm>
            </section>
        </>
    );
}
