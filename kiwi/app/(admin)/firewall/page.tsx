import type { Metadata } from "next";
import { Lock, Shield, ShieldCheck, ShieldOff } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { FirewallPending } from "@/components/firewall-pending";
import { KiwiFirewall, type FirewallInfo, type ListeningSocket, type Proto } from "@/lib/firewall";
import { requireUser } from "@/lib/session";
import { addFirewallRule, allowPort, removeFirewallRule, setFirewallEnabled } from "@/app/actions";

export const metadata: Metadata = { title: "Firewall" };

interface PortRow {
    proto: Proto;
    port: number;
    addresses: string[];
    scope: "public" | "local";
    processes: string[];
    isolated: boolean;
    host: boolean;
}

/** One row per proto/port (0.0.0.0 and :: of the same service are merged). */
function groupSockets(list: ListeningSocket[]): PortRow[] {
    const rows = new Map<string, PortRow>();
    for (const s of list) {
        const key = `${s.proto}/${s.port}`;
        const row = rows.get(key) ?? { proto: s.proto, port: s.port, addresses: [], scope: "local", processes: [], isolated: false, host: false };
        if (!row.addresses.includes(s.address)) row.addresses.push(s.address);
        if (s.scope === "public") row.scope = "public";
        if (s.process && !row.processes.includes(s.process)) row.processes.push(s.process);
        if (s.pid) {
            if (s.isolated) row.isolated = true;
            else row.host = true;
        }
        rows.set(key, row);
    }
    return [...rows.values()];
}

function Exposure({ row, info }: { row: PortRow; info: FirewallInfo }) {
    if (row.scope === "local") return <span className="badge">Local only</span>;
    if (!info.enabled) return <span className="badge badge-warn">Open to internet</span>;
    if (row.proto === "tcp" && info.protectedPorts.includes(row.port)) return <span className="badge badge-ok"><Lock size={11} aria-hidden /> Always allowed</span>;
    return KiwiFirewall.allows(info, row.proto, row.port)
        ? <span className="badge badge-ok">Allowed</span>
        : <span className="badge badge-bad">Blocked</span>;
}

export default async function FirewallPage() {
    await requireUser();
    let info: FirewallInfo | null = null;
    let error: string | null = null;
    try {
        info = await KiwiFirewall.info();
    } catch (e) {
        error = (e as Error).message;
    }

    if (!info) {
        return (
            <>
                <div className="page-head"><h1>Firewall</h1></div>
                <p className="notice notice-error" role="alert">Could not reach the kiwin daemon: {error}</p>
            </>
        );
    }

    const rows = groupSockets(info.listening);
    const blocked = rows.filter((r) => r.scope === "public" && info.enabled && !KiwiFirewall.allows(info, r.proto, r.port)).length;

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Firewall</h1>
                    <p>Controls which ports accept connections from the internet. Applies to the host and everything in the isolation.</p>
                </div>
                {info.available && (
                    <ActionForm action={setFirewallEnabled.bind(null, !info.enabled)} className="inline-form">
                        <SubmitButton variant={info.enabled ? "secondary" : "primary"}>{info.enabled ? "Disable firewall" : "Enable firewall"}</SubmitButton>
                    </ActionForm>
                )}
            </div>

            {info.pending && <FirewallPending revertAt={info.pending.revertAt} />}

            <section className="card status-card" style={{ marginBottom: 16 }}>
                <div className="status-head">
                    <span className={`status-icon ${info.enabled ? "ok" : "bad"}`}>
                        {info.enabled ? <ShieldCheck size={24} aria-hidden /> : <ShieldOff size={24} aria-hidden />}
                    </span>
                    <div>
                        <h2>{info.enabled ? "Firewall is on" : "Firewall is off"}</h2>
                        <p className="hint">
                            {!info.available
                                ? "Unavailable: kiwin must run as root on a host with nftables (nft)."
                                : info.enabled
                                    ? `Only allowed ports accept new connections${blocked ? `; ${blocked} listening port${blocked === 1 ? " is" : "s are"} blocked` : ""}.`
                                    : "Every port something listens on publicly is reachable from the internet."}
                        </p>
                    </div>
                </div>
                {info.ufwActive && (
                    <p className="notice notice-error">ufw is also active on the host. A port must be allowed in both ufw and here to be reachable.</p>
                )}
                {info.lastError && <p className="notice notice-error">Last nft error: {info.lastError}</p>}
            </section>

            <div className="grid fw-grid">
                <section className="card table-card">
                    <div className="table-toolbar"><h2>Listening ports</h2></div>
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th scope="col">Port</th>
                                    <th scope="col">Listening on</th>
                                    <th scope="col">Process</th>
                                    <th scope="col">Exposure</th>
                                    <th scope="col"><span className="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => {
                                    const exactRule = info.rules.some((x) => x.proto === r.proto && x.port === r.port && !x.to);
                                    const canAllow = info.available && r.scope === "public" && !KiwiFirewall.allows({ ...info, enabled: true }, r.proto, r.port);
                                    return (
                                        <tr key={`${r.proto}/${r.port}`}>
                                            <td><strong>{r.port}</strong> <span className="hint">{r.proto}</span></td>
                                            <td><span className="fw-addr">{r.addresses.map((a) => (a.includes(":") ? `[${a}]` : a)).join(", ")}</span></td>
                                            <td>
                                                {r.processes.join(", ") || <span className="hint">unknown</span>}
                                                {r.isolated && <span className="badge" style={{ marginLeft: 6 }}>isolation</span>}
                                                {r.host && !r.isolated && <span className="badge" style={{ marginLeft: 6 }}>host</span>}
                                            </td>
                                            <td><Exposure row={r} info={info} /></td>
                                            <td className="cell-actions">
                                                {canAllow && (
                                                    <ActionForm action={allowPort.bind(null, r.proto, r.port)} className="inline-form">
                                                        <SubmitButton variant="secondary">Allow</SubmitButton>
                                                    </ActionForm>
                                                )}
                                                {exactRule && r.scope === "public" && (
                                                    <ActionForm action={removeFirewallRule.bind(null, r.proto, r.port, null)} className="inline-form">
                                                        <SubmitButton variant="ghost" confirm={`Block ${r.proto}/${r.port} from the internet?`}>Block</SubmitButton>
                                                    </ActionForm>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section className="card">
                    <h2><Shield size={18} aria-hidden /> Allowed ports</h2>
                    <p className="hint">New connections to these ports get through while the firewall is on.</p>
                    <div className="list">
                        {info.protectedPorts.map((p) => (
                            <div className="item" key={`p${p}`}>
                                <div className="item-main">
                                    <div className="item-title">{p} <span className="hint">tcp</span></div>
                                    <div className="item-sub"><Lock size={12} aria-hidden /> Always allowed (SSH / panel)</div>
                                </div>
                            </div>
                        ))}
                        {info.rules.map((r) => (
                            <div className="item" key={`${r.proto}/${r.port}-${r.to ?? ""}`}>
                                <div className="item-main">
                                    <div className="item-title">{r.to ? `${r.port}-${r.to}` : r.port} <span className="hint">{r.proto}</span></div>
                                    {r.comment && <div className="item-sub">{r.comment}</div>}
                                </div>
                                <div className="item-actions">
                                    <ActionForm action={removeFirewallRule.bind(null, r.proto, r.port, r.to ?? null)}>
                                        <SubmitButton variant="ghost" confirm={`Stop allowing ${r.proto}/${r.to ? `${r.port}-${r.to}` : r.port}?`}>Remove</SubmitButton>
                                    </ActionForm>
                                </div>
                            </div>
                        ))}
                    </div>
                    {info.available && (
                        <ActionForm action={addFirewallRule} className="stack fw-add" resetOnSuccess>
                            <div className="fw-add-row">
                                <label>Port or range<input type="text" name="port" placeholder="8080 or 8000-8100" required inputMode="numeric" /></label>
                                <label>Protocol
                                    <select name="proto" defaultValue="tcp">
                                        <option value="tcp">TCP</option>
                                        <option value="udp">UDP</option>
                                        <option value="both">TCP + UDP</option>
                                    </select>
                                </label>
                            </div>
                            <label><span className="label-text">Note <span className="opt">(optional)</span></span><input type="text" name="comment" placeholder="e.g. Gitea SSH" maxLength={80} /></label>
                            <div className="row"><SubmitButton>Allow port</SubmitButton></div>
                        </ActionForm>
                    )}
                </section>
            </div>
        </>
    );
}
