import { Activity, AlertTriangle, BarChart3, Boxes, Braces, Cable, ChartNoAxesCombined, ChevronsUpDown, CircleGauge, Database, FileClock, Info, Layers3, Network, PanelLeft, PlayCircle, Search, ServerCog, Settings } from "lucide-react";

export const navItems = [
  ["Overview", "/", CircleGauge], ["Providers", "/providers", Network], ["Discovered Models", "/models", Boxes], ["Lanes", "/lanes", Layers3],
  ["Benchmarks", "/benchmarks", BarChart3], ["Runs", "/runs", PlayCircle],
  ["LiteLLM", "/litellm", ServerCog], ["Settings", "/settings", Settings], ["About", "/about", Info],
] as const;

export { Activity, AlertTriangle, Braces, Cable, ChartNoAxesCombined, ChevronsUpDown, Database, FileClock, Network, PanelLeft, Search, ServerCog };
