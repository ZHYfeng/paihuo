export type ID = number;

export interface RoleConfig {
  model?: string;
  system_prompt?: string;
  instructions?: string;
  skills?: string[];
  thinking?: string;
  plugins?: string[];
  extra_args?: string[];
  env?: Record<string, string>;
  custom?: Record<string, string>;
}

export interface Role {
  id: ID;
  name: string;
  description: string;
  runtime_id: string;
  role_config: RoleConfig;
  max_concurrency: number;
  enabled: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = "queued" | "claimed" | "running" | "awaiting_review" | "succeeded" | "failed" | "cancelled";

export interface Task {
  id: ID;
  title: string;
  body: string;
  status: TaskStatus;
  perm: "full" | "review";
  run_mode: "batch" | "interactive";
  concurrent: boolean;
  role_id?: ID | null;
  role_name?: string;
  project_id?: ID | null;
  project_name?: string;
  project_dir?: string;
  parent_id?: ID | null;
  depends_on?: ID | null;
  dependency_mode: "none" | "weak" | "strong";
  block_on_failure: boolean;
  error?: string;
  exit_code?: number | null;
  review_note?: string;
  review_rounds: number;
  merge_of?: ID | null;
  session_id?: ID | null;
  workflow_run_id?: ID | null;
  terminal_cols?: number;
  terminal_rows?: number;
  revision: number;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  updated_at: string;
}

export interface TaskLog {
  id: ID;
  task_id: ID;
  seq: number;
  stream: "out" | "err" | "sys" | "in";
  content: string;
  created_at: string;
}

export interface Artifact {
  id: ID;
  task_id?: ID;
  run_id?: ID;
  name: string;
  media_type: string;
  content_hash: string;
  size: number;
  created_by: string;
  retention: string;
  created_at: string;
}

export interface Project {
  id: ID;
  name: string;
  description: string;
  status: "active" | "archived";
  project_dir: string;
  is_git: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface RuntimeField {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "list" | "env";
  builtin: boolean;
  options?: string[];
  suggestions?: string[];
  thinking_options_by_model?: Record<string, string[]>;
  default?: string;
  source?: "skills" | "extensions" | "files" | "dirs";
  placeholder?: string;
  help?: string;
  group: string;
}

export interface RuntimeDescriptor {
  id: string;
  name: string;
  docs: string;
  capabilities: string[];
  fields: RuntimeField[];
  models?: Array<{ id: string; thinking_levels?: string[] }>;
  healthy: boolean;
  health?: string;
}

export interface ProvisionInfo {
  id: string;
  name: string;
  docs: string;
  installed: boolean;
  version: string;
  login: boolean;
  install_cmd: string;
  login_hint: string;
}

export interface Skill {
  id: ID;
  name: string;
  description: string;
  tags: string[];
  dir: string;
  source_path: string;
  created_at: string;
}

export interface Schedule {
  id: ID;
  name: string;
  cron: string;
  title_template: string;
  body_template: string;
  role_id: ID;
  role_name?: string;
  project_id?: ID | null;
  project_name?: string;
  perm: "full" | "review";
  block_on_failure: boolean;
  enabled: boolean;
  revision: number;
  next_run_at?: string | null;
  last_run_at?: string | null;
  created_at: string;
}

export interface TaskTemplate {
  id: ID;
  name: string;
  body: string;
  role_id?: ID | null;
  role_name?: string;
  created_at: string;
}

export interface Session {
  id: ID;
  project_id?: ID | null;
  project_name?: string;
  role_id: ID;
  role_name?: string;
  title: string;
  status: "created" | "active" | "suspended" | "delivered" | "deleted";
  runtime_id: string;
  task_id?: ID | null;
  message_count: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface OverviewStats {
  total: number;
  in_flight: number;
  succeeded: number;
  failed: number;
  reviews: number;
  projects: number;
  success_rate: number;
  avg_duration: number;
}

export interface WorkflowNode {
  id: string;
  intent: string;
  role: { role_id: ID; required_capabilities?: string[] };
  depends_on?: string[];
  permission: "full" | "review";
  allowed_actions?: string[];
  approval_required: boolean;
  input_refs?: string[];
  output_schema?: Record<string, unknown>;
  timeout_seconds: number;
  failure_policy: "stop" | "continue";
  budget: number;
}

export interface WorkflowSpec {
  version?: number;
  goal: string;
  project_id: ID;
  created_by: string;
  adoption_policy?: string;
  limits: { budget: number; max_nodes: number; max_depth: number; max_concurrency: number };
  nodes: WorkflowNode[];
}

export interface WorkflowProposal {
  id: ID;
  spec: WorkflowSpec;
  status: "proposed" | "validated" | "rejected" | "adopted";
  violations: Array<{ code: string; node_id?: string; message: string }>;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowPlan {
  id: ID;
  version: number;
  spec: WorkflowSpec;
  spec_hash: string;
  status: string;
  proposal_id?: ID;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: ID;
  plan_id: ID;
  status: string;
  task_ids: Record<string, ID>;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type VisualizationSpec =
  | { version: 1; type: "metric"; title: string; value: number | string; unit?: string }
  | { version: 1; type: "table"; title: string; columns: string[]; rows: Array<Array<string | number>> }
  | { version: 1; type: "timeline"; title: string; items: Array<{ at: string; label: string; status?: string }> }
  | { version: 1; type: "task_graph"; title: string; nodes: Array<{ id: string; label: string; status?: string }>; edges: Array<{ from: string; to: string }> }
  | { version: 1; type: "diff_summary"; title: string; added: number; removed: number; files: number }
  | { version: 1; type: "series"; title: string; points: Array<{ x: string; y: number }>; unit?: string };
