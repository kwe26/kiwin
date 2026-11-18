import { redirect } from "next/navigation";
import { KiwiAuth } from "@/lib/auth";
import { KiwiImg } from "@/lib/img";
import { currentUser } from "@/lib/session";

/** Sends you to the step you're at: storage -> master account -> sign in -> dashboard. */
export default async function Home() {
    if (!KiwiImg.exists()) redirect("/setup/storage");
    if (!KiwiAuth.hasMaster()) redirect("/setup/account");
    redirect((await currentUser()) ? "/dashboard" : "/login");
}
