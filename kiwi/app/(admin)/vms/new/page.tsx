import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { VmForm } from "@/components/vm-form";
import { requireUser } from "@/lib/session";
import { KiwiVms } from "@/lib/vms";
import { createVm } from "@/app/vm-actions";

export const metadata: Metadata = { title: "New machine" };

export default async function NewVmPage() {
    await requireUser();
    if (!KiwiVms.isInstalled()) redirect("/vms");
    const limits = KiwiVms.hostLimits();
    return (
        <>
            <div className="page-head">
                <div>
                    <h1>New machine</h1>
                    <p>Everything here can be changed later; a change takes effect the next time the machine starts.</p>
                </div>
                <Link href="/vms" className="btn btn-secondary">Back</Link>
            </div>
            <VmForm
                action={createVm}
                submit="Create machine"
                limits={{ ...limits, kvm: KiwiVms.kvmAvailable(), uefi: KiwiVms.hasUefi(), images: KiwiVms.images(), isos: KiwiVms.isos() }}
            />
        </>
    );
}
