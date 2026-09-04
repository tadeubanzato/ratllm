import { Activity, AlertTriangle, BarChart3, Boxes, Braces, Cable, ChartNoAxesCombined, ChevronsUpDown, CircleGauge, Database, FileClock, Gauge, GitPullRequestArrow, Layers3, Network, PanelLeft, PlayCircle, Search, ServerCog, Settings, ShieldAlert, Workflow } from "lucide-react";

export const navItems = [
  ["Overview", "/", CircleGauge], ["Providers", "/providers", Network], ["Models", "/models", Boxes], ["Lanes", "/lanes", Layers3],
  ["Rate Limits", "/rate-limits", Gauge], ["Benchmarks", "/benchmarks", BarChart3], ["Runs", "/runs", PlayCircle],
  ["Change Plans", "/change-plans", GitPullRequestArrow], ["Incidents", "/incidents", ShieldAlert],
  ["LiteLLM", "/litellm", ServerCog], ["n8n", "/n8n", Workflow], ["Settings", "/settings", Settings],
] as const;

export { Activity, AlertTriangle, Braces, Cable, ChartNoAxesCombined, ChevronsUpDown, Database, FileClock, Network, PanelLeft, Search, ServerCog };
