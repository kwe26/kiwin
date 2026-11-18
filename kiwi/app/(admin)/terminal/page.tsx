import type { Metadata } from "next";
import { TerminalView } from "@/components/terminal";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Terminal" };

export default async function TerminalPage() {
    await requireUser();
    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Terminal</h1>
                    <p>A root shell inside the isolation. Your storage is at <code>/www</code>.</p>
                </div>
            </div>
            <TerminalView />
        </>
    );
}
