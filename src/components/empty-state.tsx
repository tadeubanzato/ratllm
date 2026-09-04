import { Boxes } from "lucide-react";
export function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><Boxes size={26}/><strong>{title}</strong><p>{detail}</p></div>; }
