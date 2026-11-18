import type { Metadata } from "next";
import Link from "next/link";
import {
    Activity, Box, CircleAlert, CircleCheck, CircleX, Clock, Cpu, Database, Globe, HardDrive, KeyRound, Layers,
    Package, Plus, RotateCw, Server, ShieldCheck, SquareTerminal,
} from "lucide-react";
import { KiwiMysql } from "@/lib/mysql";
import { KiwiNginx } from "@/lib/nginx";
import { KiwiServices, formatBytes } from "@/lib/services";
import { KiwiSystem, formatDuration } from "@/lib/system";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };

function Fact({ icon: Icon, label, children }: { icon: typeof Clock; label: string; children: React.ReactNode }) {
    return (
        <div className="fact">
            <Icon size={16} aria-hidden />
            <span className="fact-label">{label}</span>
            <span className="fact-value">{children}</span>
        </div>
    );
}

function Meter({ used, total, label }: { used: number; total: number; label: string }) {
    const pct = total ? Math.round((used / total) * 100) : 0;
    return (
        <div className="meter-row">
            <div className="meter-head"><span>{label}</span><span>{formatBytes(used)} / {formatBytes(total)} · {pct}%</span></div>
            <div className={pct >= 90 ? "meter meter-hot" : "meter"} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
                <span style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

export default async function Dashboard() {
    const user = await requireUser();
    const [iso, units, mysqlStatus] = await Promise.all([
        KiwiSystem.isolation(),
        KiwiServices.list(),
        KiwiMysql.isSetup() ? KiwiMysql.status().catch(() => null) : null,
    ]);
    const os = KiwiSystem.ubuntu();
    const sites = KiwiNginx.list();
    const running = units.filter((u) => u.state === "running").length;
    const failed = units.filter((u) => u.state === "failed");
    const dbs = mysqlStatus?.state === "running" ? await KiwiMysql.listDatabases().catch(() => []) : null;
    const secured = sites.filter((s) => KiwiNginx.hasCert(s)).length;

    const isoUp = iso?.running ?? true; // kiwi runs inside it, so it is up if we can answer
    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Welcome back, {user}</h1>
                    <p>Here&apos;s how your server is doing.</p>
                </div>
            </div>

            <div className="grid grid-2">
                <section className="card status-card">
                    <div className="status-head">
                        <span className={isoUp ? "status-icon ok" : "status-icon bad"}><Box size={22} aria-hidden /></span>
                        <div>
                            <h2>Isolation</h2>
                            <span className={isoUp ? "pill pill-ok" : "pill pill-bad"}>
                                {isoUp ? <CircleCheck size={14} aria-hidden /> : <CircleX size={14} aria-hidden />}
                                {isoUp ? "Running" : "Stopped"}
                            </span>
                        </div>
                    </div>
                    {iso ? (
                        <div className="facts">
                            <Fact icon={Clock} label="Up for">{iso.startedAt ? formatDuration(Date.now() - iso.startedAt) : "-"}</Fact>
                            <Fact icon={RotateCw} label="Restarts">{Math.max(0, iso.launches - 1)}{iso.lastExit !== null && iso.launches > 1 ? ` (last exit ${iso.lastExit})` : ""}</Fact>
                            <Fact icon={ShieldCheck} label="Mode">{iso.rootless ? "Rootless (development)" : "Root, bubblewrap"}</Fact>
                            <Fact icon={Layers} label="Images">{iso.images.system ? "system.img" : "system directory"} · {iso.images.user ? "user.img mounted" : "no user.img"}</Fact>
                            <Fact icon={KeyRound} label="SSH">{iso.ssh ? `port ${iso.ssh.port}` : "disabled"}</Fact>
                            <Fact icon={Activity} label="Daemon up">{formatDuration(Date.now() - iso.daemonStartedAt)}</Fact>
                        </div>
                    ) : (
                        <p className="notice notice-error">
                            <CircleAlert size={15} aria-hidden /> Can&apos;t read the isolation status from the kiwin daemon. Restart the daemon so it picks up the latest version.
                        </p>
                    )}
                </section>

                <section className="card status-card">
                    <div className="status-head">
                        <span className="status-icon ubuntu"><Server size={22} aria-hidden /></span>
                        <div>
                            <h2>{os.pretty}</h2>
                            <span className="pill pill-ok"><CircleCheck size={14} aria-hidden /> Isolated · {os.hostname}</span>
                        </div>
                    </div>
                    <div className="facts">
                        <Fact icon={Layers} label="Kernel">{os.kernel} ({os.arch})</Fact>
                        <Fact icon={Cpu} label="CPU">{os.cpus} cores · load {os.load.map((l) => l.toFixed(2)).join(" ")}</Fact>
                        <Fact icon={Activity} label="Processes">{os.processes} in the isolation</Fact>
                        <Fact icon={Package} label="Packages">{os.packages ?? "-"} installed</Fact>
                    </div>
                    <Meter label="Memory (host)" used={os.memTotal - os.memAvailable} total={os.memTotal} />
                    {os.disks.map((d) => <Meter key={d.mount} label={d.mount === "/" ? "System disk" : "Storage (/www)"} used={d.used} total={d.total} />)}
                    <div className="components">
                        {os.components.map((c) => (
                            <span key={c.name} className={c.version ? "chip" : "chip chip-off"} title={c.version ? `${c.name} ${c.version}` : `${c.name} not installed`}>
                                {c.name} {c.version ?? "not installed"}
                            </span>
                        ))}
                    </div>
                </section>
            </div>

            <div className="grid grid-stats" style={{ marginTop: 16 }}>
                <Link href="/websites" className="card tile">
                    <Globe size={20} aria-hidden />
                    <div className="stat-value">{sites.length}</div>
                    <div className="stat-sub">website{sites.length === 1 ? "" : "s"} · {secured} with HTTPS</div>
                </Link>
                <Link href="/databases" className="card tile">
                    <Database size={20} aria-hidden />
                    <div className="stat-value">{dbs ? dbs.length : "-"}</div>
                    <div className="stat-sub">{dbs ? `database${dbs.length === 1 ? "" : "s"}` : KiwiMysql.isInstalled() ? "MySQL not running" : "MySQL not installed"}</div>
                </Link>
                <Link href="/services" className="card tile">
                    <Server size={20} aria-hidden />
                    <div className="stat-value">{running}/{units.length}</div>
                    <div className="stat-sub">{failed.length ? `services running · ${failed.length} failed` : "services running"}</div>
                </Link>
                <Link href="/files" className="card tile">
                    <HardDrive size={20} aria-hidden />
                    <div className="stat-value">{os.disks.find((d) => d.mount === "/www") ? formatBytes(os.disks.find((d) => d.mount === "/www")!.used) : "-"}</div>
                    <div className="stat-sub">used on storage</div>
                </Link>
            </div>

            <h2 className="section-title">Quick actions</h2>
            <div className="row">
                <Link href="/websites/new" className="btn btn-primary"><Plus size={16} aria-hidden /> Create website</Link>
                <Link href="/databases" className="btn btn-secondary"><Database size={16} aria-hidden /> New database</Link>
                <Link href="/terminal" className="btn btn-secondary"><SquareTerminal size={16} aria-hidden /> Open terminal</Link>
            </div>
        </>
    );
}
