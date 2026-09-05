"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "./icons";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const pathname = usePathname();
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark">お</span><div><strong>OKAME</strong><small>MODEL CURATOR</small></div></div>
    <nav>{navItems.map(([label, href, Icon]) => <Link key={href} href={href} className={cn(pathname === href || href !== "/" && pathname.startsWith(href) ? "active" : "")}><Icon size={16}/><span>{label}</span></Link>)}</nav>
    <div className="sidebar-foot"><span className="live-dot"/><div><strong>Control plane online</strong><small>v0.1.0 · production</small></div></div>
  </aside>;
}
