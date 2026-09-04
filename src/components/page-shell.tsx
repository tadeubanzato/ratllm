import { Topbar } from "./topbar";
export function PageShell({ title, eyebrow, children, actions }: { title: string; eyebrow?: string; children: React.ReactNode; actions?: React.ReactNode }) { return <><Topbar title={title}/><main className="page"><div className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>{actions}</div>{children}</main></>; }
