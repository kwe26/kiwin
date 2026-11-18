"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
    Activity, ArchiveRestore, ChevronRight, Table2, ArrowDownUp, ArrowUpCircle, Settings, AtSign, BrickWallFire, Inbox, Mail, Settings2, Users, Database, FileCode, Monitor, Puzzle, SlidersHorizontal, Workflow, FolderOpen, Globe, LayoutDashboard, List, Package, Plus, Server, SquareTerminal, UserRound, type LucideIcon,
} from "lucide-react";

interface NavItem {
    href: string;
    label: string;
    icon: LucideIcon;
    children?: { href: string; label: string; icon: LucideIcon; exact?: boolean; feature?: keyof NavFeatures }[];
}

const ITEMS: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    {
        href: "/websites", label: "Websites", icon: Globe,
        children: [
            { href: "/websites", label: "List", icon: List, exact: true },
            { href: "/websites/new", label: "Create", icon: Plus, exact: true },
        ],
    },
    {
        href: "/databases", label: "Databases", icon: Database,
        children: [
            { href: "/databases", label: "List", icon: List, exact: true },
            { href: "/databases/new", label: "Create", icon: Plus, exact: true },
            { href: "/databases/transfer", label: "Import / Export", icon: ArrowDownUp, exact: true },
            { href: "/databases/manager", label: "MySQL Manager", icon: Table2, feature: "mysqlManager" },
        ],
    },
    {
        href: "/mail", label: "Mail", icon: Mail,
        children: [
            { href: "/mail", label: "Domains", icon: AtSign, exact: true },
            { href: "/mail/accounts", label: "Accounts", icon: Users, exact: true },
            { href: "/mail/webmail", label: "Webmail", icon: Inbox, exact: true },
            { href: "/mail/config", label: "Config", icon: Settings2, exact: true },
        ],
    },
    { href: "/software", label: "Software", icon: Package },
    // Shown only once installed (see AdminLayout).
    {
        href: "/php", label: "PHP", icon: FileCode,
        children: [
            { href: "/php", label: "Settings", icon: SlidersHorizontal, exact: true },
            { href: "/php/extensions", label: "Extensions", icon: Puzzle, exact: true },
        ],
    },
    { href: "/pm2", label: "PM2", icon: Workflow },
    { href: "/desktop", label: "Desktop", icon: Monitor },
    { href: "/services", label: "Services", icon: Server },
    { href: "/tasks", label: "Task Manager", icon: Activity },
    { href: "/firewall", label: "Firewall", icon: BrickWallFire },
    { href: "/files", label: "Files", icon: FolderOpen },
    { href: "/terminal", label: "Terminal", icon: SquareTerminal },
    {
        href: "/settings", label: "Settings", icon: Settings,
        children: [
            { href: "/settings/account", label: "Account", icon: UserRound, exact: true },
            { href: "/settings/updates", label: "Updates", icon: ArrowUpCircle, exact: true },
            { href: "/settings/backups", label: "Backups & Restore", icon: ArchiveRestore, exact: true },
        ],
    },
];

/** Sections that only make sense once something is installed. */
const OPTIONAL: Record<string, keyof NavFeatures> = { "/php": "php", "/pm2": "pm2", "/desktop": "desktop", "/mail": "mail" };

export interface NavFeatures {
    php: boolean;
    pm2: boolean;
    desktop: boolean;
    mail: boolean;
    mysqlManager: boolean;
}

const OPEN_KEY = "kiwi.nav.open";

export function Nav({ features }: { features: NavFeatures }) {
    const path = usePathname();
    const router = useRouter();
    const within = (href: string) => path === href || path.startsWith(href + "/");
    // Groups start collapsed except the one you're in; ones you open stay open across visits.
    const [opened, setOpened] = useState<Set<string>>(new Set());
    const [closed, setClosed] = useState<Set<string>>(new Set());
    useEffect(() => {
        try {
            setOpened(new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]")));
        } catch {}
    }, []);
    // Going to another section opens its group again even if it was folded.
    useEffect(() => setClosed(new Set()), [path]);
    const isOpen = (href: string) => (opened.has(href) || within(href)) && !closed.has(href);
    const toggle = (href: string) => {
        // The bar on narrow screens shows no sub-items: go to the section instead.
        if (window.matchMedia("(max-width: 800px)").matches) return router.push(href);
        const open = !isOpen(href);
        const next = new Set(opened);
        if (open) next.add(href);
        else next.delete(href);
        setOpened(next);
        setClosed((c) => {
            const n = new Set(c);
            if (open) n.delete(href);
            else n.add(href);
            return n;
        });
        try {
            localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
        } catch {}
    };
    return (
        <nav className="nav" aria-label="Main">
            {ITEMS.filter((i) => !OPTIONAL[i.href] || features[OPTIONAL[i.href]]).map(({ href, label, icon: Icon, children }) => {
                const active = within(href);
                const expanded = !!children && isOpen(href);
                return (
                    <div key={href} className="nav-group">
                        {children ? (
                            <button type="button" className={active ? "nav-link nav-toggle open" : "nav-link nav-toggle"} aria-expanded={expanded} aria-controls={`nav-${href.slice(1)}`} onClick={() => toggle(href)}>
                                <Icon size={18} aria-hidden />
                                {label}
                                <ChevronRight size={15} className="nav-chevron" aria-hidden />
                            </button>
                        ) : (
                            <Link href={href} className={active ? "nav-link active" : "nav-link"} aria-current={active ? "page" : undefined}>
                                <Icon size={18} aria-hidden />
                                {label}
                            </Link>
                        )}
                        {expanded && (
                            <div className="nav-sub" id={`nav-${href.slice(1)}`}>
                                {children!.filter((c) => !c.feature || features[c.feature]).map(({ href: sub, label: subLabel, icon: SubIcon, exact }) => {
                                    // "List" (the group's own page) also covers detail pages like
                                    // /websites/<domain>, but not its siblings such as /websites/new.
                                    const sibling = children!.some((c) => c.href !== href && within(c.href));
                                    const subActive = exact ? path === sub || (sub === href && within(sub) && !sibling) : within(sub);
                                    return (
                                        <Link key={sub} href={sub} className={subActive ? "nav-link nav-sublink active" : "nav-link nav-sublink"} aria-current={subActive ? "page" : undefined}>
                                            <SubIcon size={15} aria-hidden />
                                            {subLabel}
                                        </Link>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                );
            })}
        </nav>
    );
}
