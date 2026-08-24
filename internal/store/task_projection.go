package store

import (
	"database/sql"
	"strings"
)

type taskScanTarget func(*taskScanState) any

type taskColumn struct {
	name        string
	expr        string
	briefExpr   string
	destination taskScanTarget
}

// taskColumns is the single ordered Task projection. Real tasks columns carry
// name; computed JOIN values leave it empty but still participate in SELECT and
// Scan ordering. briefExpr overrides only the list projection.
var taskColumns = []taskColumn{
	{name: "id", expr: "t.id", destination: func(s *taskScanState) any { return &s.task.ID }},
	{name: "type", expr: "t.type", destination: func(s *taskScanState) any { return &s.task.Type }},
	{name: "title", expr: "t.title", destination: func(s *taskScanState) any { return &s.task.Title }},
	{name: "body", expr: "t.body", briefExpr: "substr(t.body,1,400) AS body", destination: func(s *taskScanState) any { return &s.task.Body }},
	{name: "status", expr: "t.status", destination: func(s *taskScanState) any { return &s.task.Status }},
	{name: "perm", expr: "t.perm", destination: func(s *taskScanState) any { return &s.task.Perm }},
	{name: "run_mode", expr: "t.run_mode", destination: func(s *taskScanState) any { return &s.task.RunMode }},
	{name: "concurrent", expr: "t.concurrent", destination: func(s *taskScanState) any { return &s.concurrent }},
	{name: "role_id", expr: "t.role_id", destination: func(s *taskScanState) any { return &s.roleID }},
	{expr: "COALESCE(a.name, '')", destination: func(s *taskScanState) any { return &s.roleName }},
	{name: "project_id", expr: "t.project_id", destination: func(s *taskScanState) any { return &s.projectID }},
	{expr: "COALESCE(p.name, '')", destination: func(s *taskScanState) any { return &s.projectName }},
	{name: "project_dir", expr: "t.project_dir", destination: func(s *taskScanState) any { return &s.task.ProjectDir }},
	{name: "parent_id", expr: "t.parent_id", destination: func(s *taskScanState) any { return &s.parentID }},
	{name: "depends_on", expr: "t.depends_on", destination: func(s *taskScanState) any { return &s.dependsOn }},
	{name: "dependency_mode", expr: "t.dependency_mode", destination: func(s *taskScanState) any { return &s.task.DependencyMode }},
	{name: "block_on_failure", expr: "t.block_on_failure", destination: func(s *taskScanState) any { return &s.blockOnFailure }},
	{name: "schedule_id", expr: "t.schedule_id", destination: func(s *taskScanState) any { return &s.scheduleID }},
	{name: "error", expr: "t.error", destination: func(s *taskScanState) any { return &s.task.Error }},
	{name: "exit_code", expr: "t.exit_code", destination: func(s *taskScanState) any { return &s.exitCode }},
	{name: "review_note", expr: "t.review_note", destination: func(s *taskScanState) any { return &s.task.ReviewNote }},
	{name: "review_rounds", expr: "t.review_rounds", destination: func(s *taskScanState) any { return &s.task.ReviewRounds }},
	{name: "tmux_log_offset", expr: "t.tmux_log_offset", destination: func(s *taskScanState) any { return &s.task.TmuxLogOffset }},
	{name: "worktree_branch", expr: "t.worktree_branch", destination: func(s *taskScanState) any { return &s.task.WorktreeBranch }},
	{name: "base_commit", expr: "t.base_commit", destination: func(s *taskScanState) any { return &s.task.BaseCommit }},
	{name: "resume_of", expr: "t.resume_of", destination: func(s *taskScanState) any { return &s.resumeOf }},
	{name: "merge_of", expr: "t.merge_of", destination: func(s *taskScanState) any { return &s.mergeOf }},
	{name: "merge_skipped", expr: "t.merge_skipped", destination: func(s *taskScanState) any { return &s.mergeSkipped }},
	{name: "sort_order", expr: "t.sort_order", destination: func(s *taskScanState) any { return &s.task.SortOrder }},
	{name: "terminal_cols", expr: "t.terminal_cols", destination: func(s *taskScanState) any { return &s.task.TerminalCols }},
	{name: "terminal_rows", expr: "t.terminal_rows", destination: func(s *taskScanState) any { return &s.task.TerminalRows }},
	{name: "session_id", expr: "t.session_id", destination: func(s *taskScanState) any { return &s.sessionID }},
	{name: "workflow_run_id", expr: "t.workflow_run_id", destination: func(s *taskScanState) any { return &s.workflowRunID }},
	{name: "parent_session_id", expr: "t.parent_session_id", destination: func(s *taskScanState) any { return &s.parentSessionID }},
	{name: "parent_task_id", expr: "t.parent_task_id", destination: func(s *taskScanState) any { return &s.parentTaskID }},
	{name: "cron", expr: "t.cron", destination: func(s *taskScanState) any { return &s.task.Cron }},
	{name: "enabled", expr: "t.enabled", destination: func(s *taskScanState) any { return &s.enabled }},
	{name: "last_run_at", expr: "t.last_run_at", destination: func(s *taskScanState) any { return &s.lastRun }},
	{name: "next_run_at", expr: "t.next_run_at", destination: func(s *taskScanState) any { return &s.nextRun }},
	{name: "worktree_path", expr: "t.worktree_path", destination: func(s *taskScanState) any { return &s.task.WorktreePath }},
	{name: "session_dir", expr: "t.session_dir", destination: func(s *taskScanState) any { return &s.task.SessionDir }},
	{name: "last_message_at", expr: "t.last_message_at", destination: func(s *taskScanState) any { return &s.task.LastMessageAt }},
	{name: "message_count", expr: "t.message_count", destination: func(s *taskScanState) any { return &s.messageCount }},
	{name: "suspended_at", expr: "t.suspended_at", destination: func(s *taskScanState) any { return &s.suspendedAt }},
	{name: "delivered_at", expr: "t.delivered_at", destination: func(s *taskScanState) any { return &s.deliveredAt }},
	{name: "spec", expr: "t.spec", destination: func(s *taskScanState) any { return &s.task.Spec }},
	{name: "violations", expr: "t.violations", destination: func(s *taskScanState) any { return &s.task.Violations }},
	{name: "spec_hash", expr: "t.spec_hash", destination: func(s *taskScanState) any { return &s.task.SpecHash }},
	{name: "external_key", expr: "t.external_key", destination: func(s *taskScanState) any { return &s.task.ExternalKey }},
	{name: "revision", expr: "t.revision", destination: func(s *taskScanState) any { return &s.task.Revision }},
	{name: "created_at", expr: "t.created_at", destination: func(s *taskScanState) any { return &s.task.CreatedAt }},
	{name: "started_at", expr: "t.started_at", destination: func(s *taskScanState) any { return &s.started }},
	{name: "finished_at", expr: "t.finished_at", destination: func(s *taskScanState) any { return &s.finished }},
	{name: "updated_at", expr: "t.updated_at", destination: func(s *taskScanState) any { return &s.task.UpdatedAt }},
}

var (
	taskCols      = taskSelectColumns(false)
	taskColsBrief = taskSelectColumns(true)
)

func taskSelectColumns(brief bool) string {
	expressions := make([]string, len(taskColumns))
	for i, column := range taskColumns {
		expression := column.expr
		if brief && column.briefExpr != "" {
			expression = column.briefExpr
		}
		expressions[i] = expression
	}
	return strings.Join(expressions, ", ")
}

type taskScanState struct {
	task Task

	roleID, projectID, parentID, dependsOn, scheduleID, exitCode    sql.NullInt64
	resumeOf, mergeOf, sessionID, workflowRunID, parentSessionID    sql.NullInt64
	parentTaskID                                                    sql.NullInt64
	started, finished, lastRun, nextRun, suspendedAt, deliveredAt   sql.NullString
	roleName, projectName                                           string
	concurrent, blockOnFailure, enabled, messageCount, mergeSkipped int64
}

func scanTask(rows scanner) (Task, error) {
	state := taskScanState{}
	destinations := make([]any, len(taskColumns))
	for i, column := range taskColumns {
		destinations[i] = column.destination(&state)
	}
	if err := rows.Scan(destinations...); err != nil {
		return state.task, err
	}
	state.apply()
	return state.task, nil
}

func (s *taskScanState) apply() {
	if s.task.Type == "" {
		s.task.Type = TaskTypeTask
	}
	if s.task.RunMode == "" {
		s.task.RunMode = RunModeBatch
	}
	if s.task.DependencyMode == "" {
		s.task.DependencyMode = DependencyNone
	}
	s.task.Concurrent = s.concurrent != 0
	s.task.BlockOnFailure = s.blockOnFailure != 0
	s.task.Enabled = s.enabled != 0
	s.task.MergeSkipped = s.mergeSkipped != 0
	s.task.MessageCount = int(s.messageCount)
	if s.roleID.Valid {
		s.task.RoleID = &s.roleID.Int64
	}
	s.task.RoleName = s.roleName
	if s.projectID.Valid {
		s.task.ProjectID = &s.projectID.Int64
	}
	if s.resumeOf.Valid {
		s.task.ResumeOf = &s.resumeOf.Int64
	}
	if s.mergeOf.Valid {
		s.task.MergeOf = &s.mergeOf.Int64
	}
	if s.sessionID.Valid {
		s.task.SessionID = &s.sessionID.Int64
	}
	if s.workflowRunID.Valid {
		s.task.WorkflowRunID = &s.workflowRunID.Int64
	}
	if s.parentSessionID.Valid {
		s.task.ParentSessionID = &s.parentSessionID.Int64
	}
	if s.parentTaskID.Valid {
		s.task.ParentTaskID = &s.parentTaskID.Int64
	}
	s.task.ProjectName = s.projectName
	if s.parentID.Valid {
		s.task.ParentID = &s.parentID.Int64
	}
	if s.dependsOn.Valid {
		s.task.DependsOn = &s.dependsOn.Int64
	}
	if s.scheduleID.Valid {
		s.task.ScheduleID = &s.scheduleID.Int64
	}
	if s.exitCode.Valid {
		code := int(s.exitCode.Int64)
		s.task.ExitCode = &code
	}
	s.task.StartedAt = strPtr(s.started)
	s.task.FinishedAt = strPtr(s.finished)
	s.task.LastRunAt = strPtr(s.lastRun)
	s.task.NextRunAt = strPtr(s.nextRun)
	s.task.SuspendedAt = strPtr(s.suspendedAt)
	s.task.DeliveredAt = strPtr(s.deliveredAt)
}

const taskFrom = " FROM tasks t LEFT JOIN roles a ON a.id=t.role_id LEFT JOIN projects p ON p.id=t.project_id"
