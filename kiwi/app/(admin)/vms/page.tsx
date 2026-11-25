import type { Metadata } from "next";
import Link from "next/link";
import { Cpu, HardDrive, Plus } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatUptime } from "@/lib/services";
import { requireUser } from "@/lib/session";
import { KiwiVms } from "@/lib/vms";
import { vmOp } from "@/app/vm-actions";

export const metadata: Metadata = { title: "Virtual Machines" };

/** The unit state, refined by what QEMU's monitor says (a running guest can be paused). */
function badge(state: string, runState: string | null) {
    if (state === "running") {
        if (runState === "paused") return <span className="badge badge-warn">paused</span>;
        if (runState === "shutdown") return <span className="badge">shut down</span>;
        return <span className="badge badge-ok">running</span>;
    }
    if (state === "failed") return <span className="badge badge-bad">failed</span>;
    if (state === "starting" || state === "stopping") return <span className="badge badge-warn">{state}</span>;
    return <span className="badge">stopped</span>;
}

export default async function VmsPage() {
    await requireUser();

    if (!KiwiVms.isInstalled()) {
        return (
            <>
                <div className="page-head"><div><h1>Virtual Machines</h1><p>Full virtual machines on this server, with their screen in the panel.</p></div></div>
                <section className="card empty-state">
                    <Cpu size={36} aria-hidden />
                    <h2>QEMU is not installed</h2>
                    <p>Install QEMU from Software to create virtual machines: their own kernel and disks, hardware-accelerated with KVM where this server allows it.</p>
                    <Link href="/software/qemu" className="btn btn-primary">Open in Software</Link>
                </section>
            </>
        );
    }

    const vms = KiwiVms.all();
    const statuses = await KiwiVms.statuses();
    const kvm = KiwiVms.kvmAvailable();

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Virtual Machines</h1>
                    <p>
                        QEMU {KiwiVms.version() ?? ""} · {vms.length} machine{vms.length === 1 ? "" : "s"} ·{" "}
                        {kvm ? "KVM acceleration available" : "no /dev/kvm: machines are fully emulated, which is much slower"}
                    </p>
                </div>
                <div className="row">
                    <Link href="/vms/images" className="btn btn-secondary"><HardDrive size={16} aria-hidden /> Disk images</Link>
                    <Link href="/vms/new" className="btn btn-primary"><Plus size={16} aria-hidden /> New machine</Link>
                </div>
            </div>

            {!vms.length ? (
                <section className="card empty-state">
                    <Cpu size={36} aria-hidden />
                    <h2>No machines yet</h2>
                    <p>A machine gets its own disk image on your storage, boots from an ISO you put in <code>/www/isos</code>, and shows its screen right here.</p>
                    <Link href="/vms/new" className="btn btn-primary">Create a machine</Link>
                </section>
            ) : (
                <section className="card">
                    <table className="table">
                        <thead>
                            <tr><th>Machine</th><th>State</th><th>vCPU / memory</th><th>Disks</th><th>Uptime</th><th>At boot</th><th /></tr>
                        </thead>
                        <tbody>
                            {vms.map((vm) => {
                                const st = statuses[vm.name];
                                const running = st?.state === "running";
                                return (
                                    <tr key={vm.name}>
                                        <td>
                                            <Link href={`/vms/${vm.name}`}><strong>{vm.name}</strong></Link>
                                            {vm.description && <div className="hint">{vm.description}</div>}
                                            {st?.error && <div className="hint">{st.error}</div>}
                                        </td>
                                        <td>{badge(st?.state ?? "stopped", st?.runState ?? null)}</td>
                                        <td>{vm.cpus} / {vm.memoryMb} MB{vm.kvm && kvm ? "" : " (emulated)"}</td>
                                        <td>{vm.disks.length || "-"}</td>
                                        <td>{formatUptime(st?.uptime ?? null)}</td>
                                        <td>{vm.autostart ? "yes" : "no"}</td>
                                        <td className="row">
                                            {running ? (
                                                <>
                                                    <ActionForm action={vmOp.bind(null, vm.name, "shutdown")} className="inline-form">
                                                        <SubmitButton variant="secondary">Shut down</SubmitButton>
                                                    </ActionForm>
                                                    <Link href={`/vms/${vm.name}`} className="btn btn-ghost">Console</Link>
                                                </>
                                            ) : (
                                                <ActionForm action={vmOp.bind(null, vm.name, "start")} className="inline-form">
                                                    <SubmitButton>Start</SubmitButton>
                                                </ActionForm>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </section>
            )}
        </>
    );
}
