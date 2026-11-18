import { LogOut } from "lucide-react";
import { Brand } from "@/components/brand";
import { Nav } from "@/components/nav";
import { requireUser } from "@/lib/session";
import { KiwiSoftware } from "@/lib/software";
import { KiwiPhp } from "@/lib/php";
import { KiwiDesktop } from "@/lib/desktop";
import { KiwiMail } from "@/lib/mail";
import { KiwiMysqlAdmin } from "@/lib/mysql-admin";
import { logout } from "@/app/actions";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const user = await requireUser();
    const features = {
        php: KiwiPhp.versions().length > 0,
        pm2: !!(KiwiSoftware.current("nodejs") || KiwiSoftware.current("bun")),
        desktop: KiwiDesktop.isInstalled(),
        mail: KiwiMail.isInstalled(),
        mysqlManager: KiwiMysqlAdmin.enabled(),
    };
    return (
        <div className="shell">
            <aside className="sidebar">
                <Brand />
                <Nav features={features} />
                <div className="sidebar-foot">
                    <span className="who">Signed in as<strong>{user}</strong></span>
                    <form action={logout}>
                        <button type="submit" className="btn btn-secondary btn-block"><LogOut size={16} aria-hidden /> Sign out</button>
                    </form>
                </div>
            </aside>
            <main className="main">{children}</main>
        </div>
    );
}
