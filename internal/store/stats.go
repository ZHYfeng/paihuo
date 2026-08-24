package store

import (
	"database/sql"
	"time"
)

// ---------------------------------------------------------------------------
// 统计（维度二：项目进度 + agent 产出）

// statusCountsOf 按状态聚合计数。
func (s *Store) statusCountsOf(where string, args ...any) ([]StatusCount, int, error) {
	// 统计只覆盖可执行交付（type=task 且非定时定义）。
	q := "SELECT status, COUNT(*) FROM tasks t WHERE " + where + " AND t.type='task' AND t.cron='' GROUP BY status"
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []StatusCount
	total := 0
	for rows.Next() {
		var sc StatusCount
		if err := rows.Scan(&sc.Status, &sc.Count); err != nil {
			return nil, 0, err
		}
		out = append(out, sc)
		total += sc.Count
	}
	return out, total, rows.Err()
}

// inflightCount 从状态分布求和进行中任务数（queued/claimed/running/awaiting_review）。
func inflightCount(counts []StatusCount) int {
	n := 0
	for _, c := range counts {
		switch c.Status {
		case StatusQueued, StatusClaimed, StatusRunning, StatusAwaitingReview:
			n += c.Count
		}
	}
	return n
}

// dailySucceeded 最近 n 天每日完成数（succeeded，按 UTC 日期分组）。
func (s *Store) dailySucceeded(where string, days int, args ...any) ([]DailyCount, error) {
	since := time.Now().UTC().AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	rows, err := s.db.Query(
		"SELECT substr(t.finished_at,1,10) AS d, COUNT(*) FROM tasks t WHERE "+where+
			" AND t.type='task' AND t.cron='' AND t.status='succeeded' AND t.finished_at >= ? GROUP BY d", append(args, since)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DailyCount, 0, days)
	for rows.Next() {
		var d DailyCount
		if err := rows.Scan(&d.Date, &d.Count); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// terminalSummary 终态任务的计数 + 成功率 + 平均耗时（秒）。
func (s *Store) terminalSummary(where string, args ...any) (total, done, fail, reviews int, rate, avgDur float64, err error) {
	q := "SELECT COUNT(*), COALESCE(SUM(CASE WHEN t.status='succeeded' THEN 1 ELSE 0 END),0), " +
		"COALESCE(SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END),0), COALESCE(SUM(t.review_rounds),0), " +
		"COALESCE(SUM(CASE WHEN t.status IN ('succeeded','failed') THEN (julianday(t.finished_at)-julianday(t.started_at)) ELSE 0 END),0) " +
		"FROM tasks t WHERE " + where + " AND t.type='task' AND t.cron=''"
	row := s.db.QueryRow(q, args...)
	var durDays float64
	if err := row.Scan(&total, &done, &fail, &reviews, &durDays); err != nil {
		return 0, 0, 0, 0, 0, 0, err
	}
	if total > 0 {
		rate = float64(done) / float64(total) * 100
	}
	denom := done + fail
	if denom > 0 {
		avgDur = durDays * 86400 / float64(denom)
	}
	return total, done, fail, reviews, rate, avgDur, nil
}

// RoleStatsOf 汇总某个 agent 的全部产出统计。
func (s *Store) RoleStatsOf(roleID int64) (*RoleStats, error) {
	st := &RoleStats{RoleID: roleID}
	agent, err := s.GetRole(roleID)
	if err != nil {
		return nil, err
	}
	st.RoleName = agent.Name
	st.RuntimeID = agent.RuntimeID

	total, done, fail, reviews, rate, avgDur, err := s.terminalSummary("t.role_id=?", roleID)
	if err != nil {
		return nil, err
	}
	st.Total, st.Succeeded, st.Failed, st.Reviews = total, done, fail, reviews
	st.SuccessRate, st.AvgDuration = rate, avgDur

	counts, _, err := s.statusCountsOf("t.role_id=?", roleID)
	if err != nil {
		return nil, err
	}
	st.StatusCounts = counts
	st.InFlight = inflightCount(counts)
	for _, c := range counts {
		if c.Status == StatusCancelled {
			st.Cancelled = c.Count
		}
	}

	rows, err := s.db.Query(`SELECT t.role_id, t.project_id, COALESCE(p.name,''), COUNT(*),
		COALESCE(SUM(CASE WHEN t.status='succeeded' THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END),0),
		COALESCE(SUM(t.review_rounds),0),
		COALESCE(SUM(CASE WHEN t.status IN ('succeeded','failed') THEN (julianday(t.finished_at)-julianday(t.started_at)) ELSE 0 END),0)
		FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
		WHERE t.role_id=? AND t.type='task' AND t.cron='' GROUP BY t.project_id, p.name ORDER BY COUNT(*) DESC`, roleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ps RoleProjectStat
		var dur float64
		var n int
		var aid, pid sql.NullInt64
		if err := rows.Scan(&aid, &pid, &ps.ProjectName, &n, &ps.Succeeded, &ps.Failed, &ps.Reviews, &dur); err != nil {
			return nil, err
		}
		ps.RoleID = roleID
		if pid.Valid {
			ps.ProjectID = pid.Int64
		}
		ps.RoleName = agent.Name
		ps.Total = n
		if n > 0 {
			ps.SuccessRate = float64(ps.Succeeded) / float64(n) * 100
		}
		if denom := ps.Succeeded + ps.Failed; denom > 0 {
			ps.AvgDuration = dur * 86400 / float64(denom)
		}
		st.Projects = append(st.Projects, ps)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	daily, err := s.dailySucceeded("t.role_id=?", 14, roleID)
	if err != nil {
		return nil, err
	}
	st.Daily = daily
	if st.StatusCounts == nil {
		st.StatusCounts = []StatusCount{}
	}
	if st.Projects == nil {
		st.Projects = []RoleProjectStat{}
	}
	if st.Daily == nil {
		st.Daily = []DailyCount{}
	}
	return st, nil
}

// ProjectStatsOf 汇总项目进度 + 在该项目工作的 Role 产出。
func (s *Store) ProjectStatsOf(projectID int64) (*ProjectStats, error) {
	ps := &ProjectStats{ProjectID: projectID}
	proj, err := s.GetProject(projectID)
	if err != nil {
		return nil, err
	}
	ps.ProjectName = proj.Name

	total, done, fail, reviews, rate, avgDur, err := s.terminalSummary("t.project_id=?", projectID)
	if err != nil {
		return nil, err
	}
	ps.Total, ps.Succeeded, ps.Failed, ps.Reviews = total, done, fail, reviews
	if total > 0 {
		ps.Progress = float64(done) / float64(total) * 100
	}
	_ = rate
	_ = avgDur

	counts, _, err := s.statusCountsOf("t.project_id=?", projectID)
	if err != nil {
		return nil, err
	}
	ps.StatusCounts = counts
	ps.InFlight = inflightCount(counts)

	rows, err := s.db.Query(`SELECT t.role_id, t.project_id, COALESCE(a.name,''), COALESCE(p.name,''), COUNT(*),
		COALESCE(SUM(CASE WHEN t.status='succeeded' THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END),0),
		COALESCE(SUM(t.review_rounds),0),
		COALESCE(SUM(CASE WHEN t.status IN ('succeeded','failed') THEN (julianday(t.finished_at)-julianday(t.started_at)) ELSE 0 END),0)
		FROM tasks t LEFT JOIN roles a ON a.id=t.role_id LEFT JOIN projects p ON p.id=t.project_id
		WHERE t.project_id=? AND t.type='task' AND t.cron='' GROUP BY t.role_id, a.name ORDER BY COUNT(*) DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ag RoleProjectStat
		var dur float64
		var n int
		var aid, pid sql.NullInt64
		if err := rows.Scan(&aid, &pid, &ag.RoleName, &ag.ProjectName, &n, &ag.Succeeded, &ag.Failed, &ag.Reviews, &dur); err != nil {
			return nil, err
		}
		if aid.Valid {
			ag.RoleID = aid.Int64
		}
		ag.ProjectID = projectID
		ag.Total = n
		if n > 0 {
			ag.SuccessRate = float64(ag.Succeeded) / float64(n) * 100
		}
		if denom := ag.Succeeded + ag.Failed; denom > 0 {
			ag.AvgDuration = dur * 86400 / float64(denom)
		}
		ps.Roles = append(ps.Roles, ag)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	daily, err := s.dailySucceeded("t.project_id=?", 14, projectID)
	if err != nil {
		return nil, err
	}
	ps.Daily = daily
	if ps.StatusCounts == nil {
		ps.StatusCounts = []StatusCount{}
	}
	if ps.Roles == nil {
		ps.Roles = []RoleProjectStat{}
	}
	if ps.Daily == nil {
		ps.Daily = []DailyCount{}
	}
	return ps, nil
}

// OverviewStatsOf 全局总览。
func (s *Store) OverviewStatsOf() (*OverviewStats, error) {
	ov := &OverviewStats{}
	total, done, fail, reviews, rate, avgDur, err := s.terminalSummary("1=1")
	if err != nil {
		return nil, err
	}
	ov.Total, ov.Succeeded, ov.Failed, ov.Reviews = total, done, fail, reviews
	ov.SuccessRate, ov.AvgDuration = rate, avgDur

	counts, _, err := s.statusCountsOf("1=1")
	if err != nil {
		return nil, err
	}
	ov.StatusCounts = counts
	ov.InFlight = inflightCount(counts)

	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM projects").Scan(&n); err != nil {
		return nil, err
	}
	ov.Projects = n

	daily, err := s.dailySucceeded("1=1", 14)
	if err != nil {
		return nil, err
	}
	ov.Daily = daily
	if ov.StatusCounts == nil {
		ov.StatusCounts = []StatusCount{}
	}
	if ov.Daily == nil {
		ov.Daily = []DailyCount{}
	}
	return ov, nil
}
