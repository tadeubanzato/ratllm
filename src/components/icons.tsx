import { Activity, AlertTriangle, BarChart3, Boxes, Braces, Cable, ChartNoAxesCombined, ChevronsUpDown, CircleGauge, Database, FileClock, Info, Layers3, Network, PanelLeft, PlayCircle, Search, ServerCog, Settings } from "lucide-react";

type NavItem = readonly [label: string, href: string, icon: typeof CircleGauge];
/** The menu, in sections. What RatLLM itself does comes first; everything about the LiteLLM router it manages sits under its own heading. */
export const navGroups: ReadonlyArray<{ label?: string; items: readonly NavItem[] }> = [
  { items: [["Overview", "/", CircleGauge], ["Providers", "/providers", Network], ["Discovered Models", "/models", Boxes], ["Automation Runs", "/runs", PlayCircle]] },
  { label: "LiteLLM", items: [["LiteLLM", "/litellm", ServerCog], ["Lanes", "/lanes", Layers3], ["Performance", "/performance", BarChart3]] },
  { items: [["Settings", "/settings", Settings], ["About", "/about", Info]] },
];
export const navItems: readonly NavItem[] = navGroups.flatMap(group => group.items);

export { Activity, AlertTriangle, Braces, Cable, ChartNoAxesCombined, ChevronsUpDown, Database, FileClock, Network, PanelLeft, Search, ServerCog };
