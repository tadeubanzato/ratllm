"use client";
import { PanelLeft } from "./icons";
import { SearchPalette } from "./search-palette";

export function Topbar({ title, showSearch = true }: { title?: string; showSearch?: boolean }) {
  function toggle() { const next = document.documentElement.dataset.theme !== "dark"; localStorage.setItem("theme", next ? "dark" : "light"); document.documentElement.dataset.theme = next ? "dark" : "light"; }
  const today = new Intl.DateTimeFormat("en", { weekday:"long", month:"long", day:"numeric" }).format(new Date());
  return <header className="topbar"><button className="mobile-menu" aria-label="Open navigation"><PanelLeft size={18}/></button><div><h1>{title ?? "Operations overview"}</h1><p>{today} · <span>Control plane online</span></p></div><div className="top-actions">{showSearch && <SearchPalette/>}<button className="theme-button" onClick={toggle} aria-label="Toggle color theme">◐</button><div className="avatar">TB</div></div></header>;
}
