"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "./icons";
import type { SearchResult } from "@/app/api/search/route";

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function openPalette() {
    setQuery("");
    setResults([]);
    setActiveIndex(0);
    setOpen(true);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(o => { if (!o) { setQuery(""); setResults([]); setActiveIndex(0); } return !o; }); }
      else if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then(r => (r.ok ? r.json() : { results: [] }))
        .then((data: { results: SearchResult[] }) => { setResults(data.results ?? []); setActiveIndex(0); })
        .catch(() => {});
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, open]);

  function go(href: string) { setOpen(false); router.push(href); }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = results[activeIndex]; if (r) go(r.href); }
  }

  return <>
    <button className="search-button" type="button" onClick={openPalette} aria-label="Search models, providers, lanes, and runs">
      <Search size={15}/><span>Search models, providers, runs…</span><kbd>⌘K</kbd>
    </button>
    {open && <div className="search-overlay" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
      <div className="search-panel" onClick={e => e.stopPropagation()}>
        <div className="search-input-row">
          <Search size={16}/>
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onInputKeyDown} placeholder="Search models, providers, lanes, runs…"/>
          <kbd>Esc</kbd>
        </div>
        <div className="search-results" role="listbox" aria-label="Search results">
          {query.trim().length >= 2 && results.length === 0 && <p className="search-empty">No matches</p>}
          {query.trim().length >= 2 && results.map((r, i) => <button key={`${r.type}-${r.href}-${i}`} type="button" role="option" aria-selected={i === activeIndex} className={"search-result" + (i === activeIndex ? " active" : "")} onMouseEnter={() => setActiveIndex(i)} onClick={() => go(r.href)}>
            <span className="search-result-type">{r.type}</span>
            <span className="search-result-label">{r.label}</span>
            {r.sublabel && <span className="search-result-sub">{r.sublabel}</span>}
          </button>)}
        </div>
      </div>
    </div>}
  </>;
}
