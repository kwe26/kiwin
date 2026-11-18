"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Pause, Play, Search, Skull, X } from "lucide-react";
import type { TaskProcess, TaskSample, TaskSnapshot } from "@/lib/tasks";

type SortKey = "name" | "pid" | "cpu" | "rssBytes" | "swapBytes" | "user" | "unit";

const STATE: Record<string, { label: string; className: string }> = {
    R: { label: "Running", className: "badge badge-ok" },
    S: { label: "Sleeping", className: "badge" },
    I: { label: "Idle", className: "badge" },
    D: { label: "Waiting (disk)", className: "badge badge-warn" },
    T: { label: "Suspended", className: "badge badge-warn" },
    t: { label: "Stopped (trace)", className: "badge badge-warn" },
    Z: { label: "Zombie", className: "badge badge-bad" },
};

function bytes(n: number): string {
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Windows Task Manager-style area graph of the last 60 seconds, newest on the right. */
function Graph({ samples, value, max, color }: { samples: number[]; value: string; max: number; color: string }) {
    const W = 300, H = 100, N = 60;
    const pts = samples.slice(-N);
    const x = (i: number) => W - (pts.length - 1 - i) * (W / (N - 1));
    const y = (v: number) => H - Math.min(1, v / (max || 1)) * H;
    const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = pts.length ? `${x(0).toFixed(1)},${H} ${line} ${W},${H}` : "";
    return (
        <div className="tm-graph">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={value}>
                {Array.from({ length: 9 }, (_, i) => <line key={`v${i}`} x1={(i + 1) * (W / 10)} x2={(i + 1) * (W / 10)} y1={0} y2={H} className="tm-grid" />)}
                {Array.from({ length: 4 }, (_, i) => <line key={`h${i}`} y1={(i + 1) * (H / 5)} y2={(i + 1) * (H / 5)} x1={0} x2={W} className="tm-grid" />)}
                {area && <polygon points={area} fill={color} fillOpacity={0.18} />}
                {line && <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
            </svg>
        </div>
    );
}

export function TaskManager() {
    const [snap, setSnap] = useState<TaskSnapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "cpu", desc: true });
    const [busy, setBusy] = useState<number | null>(null);
    const [paused, setPaused] = useState(false);

    const load = useCallback(async () => {
        const res = await fetch("/api/tasks", { cache: "no-store" }).catch(() => null);
        if (!res?.ok) {
            setError(res ? `Could not read processes (HTTP ${res.status})` : "The panel is unreachable");
            return;
        }
        setSnap(await res.json());
        setError(null);
    }, []);

    useEffect(() => {
        if (paused) return;
        load();
        const t = setInterval(load, 1000);
        return () => clearInterval(t);
    }, [load, paused]);

    const act = async (p: TaskProcess, action: "suspend" | "resume" | "terminate" | "kill") => {
        if (action === "kill" && !window.confirm(`Kill ${p.name} (${p.pid})? It is stopped at once, without a chance to save anything.`)) return;
        if (action === "terminate" && !window.confirm(`End ${p.name} (${p.pid})?${p.unit ? ` It belongs to the ${p.unit} service, which may restart it.` : ""}`)) return;
        setBusy(p.pid);
        const res = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: p.pid, action }) });
        const data = await res.json().catch(() => ({}));
        setBusy(null);
        if (!res.ok) window.alert(data.error ?? "Failed");
        load();
    };

    const rows = useMemo(() => {
        if (!snap) return [];
        const q = query.trim().toLowerCase();
        const list = snap.processes.filter((p) => !q || p.name.toLowerCase().includes(q) || p.command.toLowerCase().includes(q) || String(p.pid) === q || (p.unit ?? "").includes(q));
        const dir = sort.desc ? -1 : 1;
        return list.sort((a, b) => {
            const x = a[sort.key] ?? "", y = b[sort.key] ?? "";
            return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir || a.pid - b.pid;
        });
    }, [snap, query, sort]);

    const header = (key: SortKey, label: string, num = false) => (
        <th scope="col" className={num ? "num" : undefined} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
            <button type="button" className="tm-sort" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === "cpu" || key === "rssBytes" || key === "swapBytes" }))}>
                {label}{sort.key === key && (sort.desc ? <ArrowDown size={12} aria-hidden /> : <ArrowUp size={12} aria-hidden />)}
            </button>
        </th>
    );

    const history: TaskSample[] = snap?.history ?? [];
    const memPct = snap && snap.memTotal ? (snap.current.mem / snap.memTotal) * 100 : 0;
    const swapPct = snap && snap.swapTotal ? (snap.current.swap / snap.swapTotal) * 100 : 0;

    return (
        <div className="stack" style={{ gap: 16 }}>
            {error && <p className="notice notice-error" role="alert">{error}</p>}
            <div className="tm-graphs">
                <section className="card tm-card">
                    <div className="tm-card-head">
                        <h2>CPU</h2>
                        <span className="tm-value">{snap ? `${snap.current.cpu.toFixed(1)}%` : "…"}</span>
                    </div>
                    <Graph samples={history.map((s) => s.cpu)} max={100} value={`CPU ${snap?.current.cpu ?? 0}%`} color="var(--tm-cpu)" />
                    <p className="hint">% of all {snap?.cpus ?? "…"} cores used by the isolation · last 60 seconds</p>
                </section>
                <section className="card tm-card">
                    <div className="tm-card-head">
                        <h2>Memory</h2>
                        <span className="tm-value">{snap ? `${bytes(snap.current.mem)} (${memPct.toFixed(0)}%)` : "…"}</span>
                    </div>
                    <Graph samples={history.map((s) => s.mem)} max={snap?.memTotal ?? 1} value={`Memory ${memPct.toFixed(0)}%`} color="var(--tm-mem)" />
                    <p className="hint">
                        Used by the isolation&apos;s processes of {snap ? bytes(snap.memTotal) : "…"}
                        {snap ? ` · ${bytes(snap.memAvailable)} available on the machine` : ""}
                    </p>
                </section>
                <section className="card tm-card">
                    <div className="tm-card-head">
                        <h2>Swap</h2>
                        <span className="tm-value">{!snap ? "…" : snap.swapTotal ? `${bytes(snap.current.swap)} (${swapPct.toFixed(0)}%)` : "None"}</span>
                    </div>
                    <Graph samples={history.map((s) => s.swap ?? 0)} max={snap?.swapTotal || 1} value={`Swap ${swapPct.toFixed(0)}%`} color="var(--tm-swap)" />
                    <p className="hint">
                        {!snap ? "…" : snap.swapTotal
                            ? `In use on the machine, of ${bytes(snap.swapTotal)} · ${bytes(snap.swapIsolation)} by the isolation's processes`
                            : "This machine has no swap"}
                    </p>
                </section>
            </div>

            <section className="card table-card">
                <div className="table-toolbar tm-toolbar">
                    <h2>Processes <span className="hint">{snap ? `${snap.processes.length} in the isolation` : ""}</span></h2>
                    <div className="row">
                        <label className="sw-search">
                            <Search size={16} aria-hidden />
                            <span className="sr-only">Filter processes</span>
                            <input type="search" placeholder="Filter by name, command, PID or service" value={query} onChange={(e) => setQuery(e.target.value)} />
                        </label>
                        <button type="button" className={paused ? "btn btn-secondary active" : "btn btn-ghost"} onClick={() => setPaused((p) => !p)}>
                            {paused ? <Play size={15} aria-hidden /> : <Pause size={15} aria-hidden />} {paused ? "Resume updates" : "Pause updates"}
                        </button>
                    </div>
                </div>
                <div className="table-wrap">
                    <table className="table tm-table">
                        <thead>
                            <tr>
                                {header("name", "Name")}
                                {header("pid", "PID", true)}
                                {header("unit", "Service")}
                                {header("user", "User")}
                                <th scope="col">Status</th>
                                {header("cpu", "CPU", true)}
                                {header("rssBytes", "Memory", true)}
                                {header("swapBytes", "Swap", true)}
                                <th scope="col"><span className="sr-only">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((p) => {
                                const st = STATE[p.state] ?? { label: p.state, className: "badge" };
                                const suspended = p.state === "T";
                                return (
                                    <tr key={p.pid} className={suspended ? "tm-suspended" : undefined}>
                                        <td>
                                            <strong>{p.name}</strong>
                                            <div className="hint truncate tm-cmd" title={p.command}>{p.command}</div>
                                        </td>
                                        <td className="num">{p.pid}</td>
                                        <td>{p.unit ? <span className="chip">{p.unit}</span> : <span className="hint">-</span>}</td>
                                        <td>{p.user}</td>
                                        <td><span className={st.className}>{st.label}</span></td>
                                        <td className="num"><span className="tm-cpu" style={{ "--v": `${Math.min(100, p.cpu * (snap?.cpus ?? 1))}%` } as React.CSSProperties}>{p.cpu.toFixed(1)}%</span></td>
                                        <td className="num">{bytes(p.rssBytes)}</td>
                                        <td className="num">{p.swapBytes ? bytes(p.swapBytes) : <span className="hint">-</span>}</td>
                                        <td className="cell-actions">
                                            {p.protected ? <span className="hint">protected</span> : (
                                                <div className="item-actions" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                                                    {suspended ? (
                                                        <button type="button" className="btn btn-ghost" disabled={busy === p.pid} onClick={() => act(p, "resume")} title="Resume (SIGCONT)"><Play size={15} aria-hidden /> Resume</button>
                                                    ) : (
                                                        <button type="button" className="btn btn-ghost" disabled={busy === p.pid} onClick={() => act(p, "suspend")} title="Suspend (SIGSTOP)"><Pause size={15} aria-hidden /> Suspend</button>
                                                    )}
                                                    <button type="button" className="btn btn-ghost" disabled={busy === p.pid} onClick={() => act(p, "terminate")} title="End task (SIGTERM)"><X size={15} aria-hidden /> End</button>
                                                    <button type="button" className="btn btn-ghost btn-ghost-danger" disabled={busy === p.pid} onClick={() => act(p, "kill")} title="Kill (SIGKILL)"><Skull size={15} aria-hidden /> Kill</button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
