import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { StorageForm } from "@/components/storage-form";
import { KiwiImg } from "@/lib/img";

export const metadata: Metadata = { title: "Create storage" };

export default function StorageSetup() {
    if (KiwiImg.exists()) redirect("/");
    return (
        <main className="auth">
            <div className="card auth-card">
                <Brand />
                <h1>Create your storage</h1>
                <p className="lead">Your sites, databases and settings live on this volume. It only uses the disk space its data needs.</p>
                <StorageForm sizes={KiwiImg.availableSizes()} freeGB={KiwiImg.freeGB()} suggestedGB={KiwiImg.suggestedGB()} />
            </div>
        </main>
    );
}
