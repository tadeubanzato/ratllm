"use client";
import { useEffect } from "react";
import { createPortal } from "react-dom";

/** Rendered via a portal straight onto document.body — not as a child of whatever triggered it. A modal opened
 *  from inside a table cell (nowrap text, clipped overflow) or any other constrained ancestor previously inherited
 *  those properties (a `<td>`'s white-space:nowrap forced every sentence in the modal onto one unbreakable line,
 *  blowing out its width) since it rendered inline in the DOM despite being visually fixed-position. A portal
 *  makes the modal a sibling of the trigger's whole page instead, immune to that class of ancestor CSS leakage. */
export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header"><h3>{title}</h3><button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
