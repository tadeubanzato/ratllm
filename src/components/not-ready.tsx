import { PageShell } from "./page-shell";
export function NotReady({title,description}:{title:string;description:string}){return <PageShell title={title} eyebrow="Planned control-plane capability"><section className="panel"><div className="empty-state"><strong>{title} is not enabled in milestone 1</strong><p>{description}</p></div></section></PageShell>}
