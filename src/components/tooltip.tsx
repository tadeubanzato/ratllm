"use client";

import { useId, useState } from "react";

/** Small, accessible help tooltip. Use Popover/help text for interactive content. */
export function Tooltip({ label, children }: { label: string; children: React.ReactElement }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <span className="tooltip-anchor">
      <span
        className="tooltip-trigger"
        tabIndex={0}
        aria-describedby={visible ? id : undefined}
        onBlur={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
      >{children}</span>
      {visible && <span id={id} className="tooltip-content" role="tooltip">{label}</span>}
    </span>
  );
}
