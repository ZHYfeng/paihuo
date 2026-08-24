import type {
  ID,
  Project,
  ProjectStatus,
  Role,
  RoleConfig,
  Task,
  TaskDependencyMode,
  TaskPerm,
  TaskRunMode,
  TaskType,
} from "./generated/store-types";

export type {
  ID,
  Project,
  ProjectStatus,
  Role,
  RoleConfig,
  Task,
  TaskDependencyMode,
  TaskPerm,
  TaskRunMode,
  TaskType,
};

export type TaskStatus = "queued" | "claimed" | "running" | "awaiting_review" | "succeeded" | "failed" | "cancelled";

/** 表单草稿允许逐项填写；API 返回的 RoleConfig 仍使用生成的完整 DTO。 */
export type RoleConfigDraft = Partial<RoleConfig>;

/** 会话 = type=session 的任务（字段全部在 Task 上）。 */
export type Session = Task;

export interface TaskLog {
  id: ID;
  task_id: ID;
  seq: number;
  stream: "out" | "err" | "sys" | "in" | "term";
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
  /** 分类（文件夹）：导入时从源目录父文件夹推断，可单独/批量调整 */
  category?: string;
  tags: string[];
  dir: string;
  source_path: string;
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

export interface OverviewStats {
  total: number;
  in_flight: number;
  succeeded: number;
  failed: number;
  reviews: number;
  projects: number;
  success_rate: number;
  avg_duration: number;
  status_counts: StatusCount[];
  daily: DailyCount[];
}

export interface StatusCount {
  status: string;
  count: number;
}

export interface RoleProjectStat {
  role_id: ID;
  role_name: string;
  project_id: ID;
  project_name: string;
  total: number;
  succeeded: number;
  failed: number;
  reviews: number;
  success_rate: number;
  avg_duration: number;
}

export interface DailyCount {
  date: string;
  count: number;
}

export interface ProjectStats {
  project_id: ID;
  project_name: string;
  total: number;
  in_flight: number;
  succeeded: number;
  failed: number;
  reviews: number;
  progress: number;
  status_counts: StatusCount[];
  roles: RoleProjectStat[];
  daily: DailyCount[];
}

export interface WorkspaceStatus {
  path: string;
  is_git: boolean;
  is_worktree: boolean;
  branch: string;
  base_commit: string;
  head: string;
  dirty: boolean;
  ahead: number;
  merged: boolean;
  note?: string;
}

export interface TaskLogPage {
  logs: TaskLog[];
  has_more: boolean;
  total: number;
}

export interface RoleStats {
  role_id: ID;
  role_name: string;
  runtime_id: string;
  total: number;
  in_flight: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  reviews: number;
  success_rate: number;
  avg_duration: number;
  status_counts: StatusCount[];
  projects: RoleProjectStat[];
  daily: DailyCount[];
}

export interface RoleStudioDraft {
  name: string;
  description: string;
  runtime_id: string;
  max_concurrency: number;
  delegation_enabled: boolean;
  delegation_max_perm: string;
  role_config: RoleConfigDraft;
}

export interface RoleStudioMessage {
  role: string;
  content: string;
}

export interface RoleStudioResult {
  message: string;
  draft?: RoleStudioDraft;
}

export interface ExtensionOutput {
  raw: string;
  error?: string;
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
  created_by: string;
  limits: { budget: number; max_nodes: number; max_depth: number; max_concurrency: number };
  nodes: WorkflowNode[];
}

export interface WorkflowRun {
  id: ID;
  workflow_id: ID;
  project_id: ID;
  /** 本次 Run 的自定义任务描述（可为空 = 纯模板执行）；渲染进节点意图并记录在书签上 */
  task?: string;
  status: string;
  task_ids: Record<string, ID>;
  revision: number;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  updated_at: string;
}

export type VisualizationSpec =
  | { version: 1; type: "metric"; title: string; value: number | string; unit?: string }
  | { version: 1; type: "table"; title: string; columns: string[]; rows: Array<Array<string | number>> }
  | { version: 1; type: "timeline"; title: string; items: Array<{ at: string; label: string; status?: string }> }
  | { version: 1; type: "task_graph"; title: string; nodes: Array<{ id: string; label: string; status?: string }>; edges: Array<{ from: string; to: string }> }
  | { version: 1; type: "diff_summary"; title: string; added: number; removed: number; files: number }
  | { version: 1; type: "series"; title: string; points: Array<{ x: string; y: number }>; unit?: string };
