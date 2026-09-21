"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { navGroups } from "./icons";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const pathname = usePathname();
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg></span><div><strong>RATLLM</strong><small>MODEL CURATOR</small></div></div>
    <nav>{navGroups.map((group, index) => <div key={group.label ?? index} className="nav-group" role={group.label ? "group" : undefined} aria-label={group.label}>
      {group.label && <div className="nav-heading">{group.label}</div>}
      {group.items.map(([label, href, Icon]) => <Link key={href} href={href} className={cn(pathname === href || href !== "/" && pathname.startsWith(href) ? "active" : "")}><Icon size={16}/><span>{label}</span></Link>)}
    </div>)}</nav>
    <div className="sidebar-foot"><span className="live-dot"/><div><strong>Control plane online</strong><small>v0.1.0 · production</small></div></div>
  </aside>;
}
