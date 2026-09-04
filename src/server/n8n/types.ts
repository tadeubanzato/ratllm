export interface N8nWorkflow {
  id?: string;
  name: string;
  active?: boolean;
  nodes: Array<Record<string, unknown>>;
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface WorkflowInstallResult {
  id: string;
  name: string;
  action: "created" | "updated";
  active: boolean;
}
