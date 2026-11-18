import type { Metadata } from "next";
import { TaskManager } from "@/components/task-manager";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Task Manager" };

export default async function TasksPage() {
    await requireUser();
    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Task Manager</h1>
                    <p>Processes running inside the isolation (the host&apos;s own processes are not shown). Suspend, resume, end or kill them; updates every second.</p>
                </div>
            </div>
            <TaskManager />
        </>
    );
}
