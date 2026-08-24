package store

import "database/sql"

func (s *Store) AppendEvent(eventType string, taskID, roleID int64, payload []byte) (EventRecord, error) {
	now := Now()
	res, err := s.db.Exec(`INSERT INTO event_log(event_type, task_id, role_id, payload, created_at)
		VALUES(?, NULLIF(?, 0), NULLIF(?, 0), ?, ?)`, eventType, taskID, roleID, string(payload), now)
	if err != nil {
		return EventRecord{}, err
	}
	seq, err := res.LastInsertId()
	if err != nil {
		return EventRecord{}, err
	}
	return EventRecord{Seq: seq, Type: eventType, TaskID: taskID, RoleID: roleID, Payload: payload, CreatedAt: now}, nil
}

// ListEventsAfter returns a forward-only page for reconnecting SSE clients.
func (s *Store) ListEventsAfter(after int64, limit int) ([]EventRecord, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	rows, err := s.db.Query(`SELECT seq, event_type, COALESCE(task_id, 0), COALESCE(role_id, 0), payload, created_at
		FROM event_log WHERE seq > ? ORDER BY seq LIMIT ?`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]EventRecord, 0)
	for rows.Next() {
		var item EventRecord
		if err := rows.Scan(&item.Seq, &item.Type, &item.TaskID, &item.RoleID, &item.Payload, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// 任务日志

func (s *Store) AppendLog(l TaskLog) (TaskLog, error) {
	if l.CreatedAt == "" {
		l.CreatedAt = Now()
	}
	err := s.db.QueryRow(
		"SELECT COALESCE(MAX(seq),0)+1 FROM task_logs WHERE task_id=?", l.TaskID).Scan(&l.Seq)
	if err != nil {
		return l, err
	}
	res, err := s.db.Exec(`INSERT INTO task_logs (task_id, seq, stream, content, created_at) VALUES (?, ?, ?, ?, ?)`,
		l.TaskID, l.Seq, l.Stream, l.Content, l.CreatedAt)
	if err != nil {
		return l, err
	}
	l.ID, _ = res.LastInsertId()
	return l, nil
}

func (s *Store) ListLogs(taskID int64) ([]TaskLog, error) {
	rows, err := s.db.Query("SELECT id, task_id, seq, stream, content, created_at FROM task_logs WHERE task_id=? ORDER BY seq", taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]TaskLog, 0)
	for rows.Next() {
		var l TaskLog
		if err := rows.Scan(&l.ID, &l.TaskID, &l.Seq, &l.Stream, &l.Content, &l.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ListLogsPage 返回日志的一个窗口。默认从最新日志向前取，beforeSeq 不为零时
// 只取更早的记录；结果仍按 seq 正序返回，方便前端直接追加到终端顶部。
// 日志内容可能非常大，任务详情页不应为了打开一个任务把整张表读入内存。
func (s *Store) ListLogsPage(taskID, beforeSeq int64, limit int) (logs []TaskLog, hasMore bool, total int, err error) {
	const defaultLimit = 200
	const maxLimit = 500
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}

	if err = s.db.QueryRow("SELECT COUNT(*) FROM task_logs WHERE task_id=?", taskID).Scan(&total); err != nil {
		return nil, false, 0, err
	}

	const cols = "SELECT id, task_id, seq, stream, content, created_at FROM task_logs WHERE task_id=?"
	var rows *sql.Rows
	if beforeSeq > 0 {
		rows, err = s.db.Query(cols+" AND seq<? ORDER BY seq DESC LIMIT ?", taskID, beforeSeq, limit+1)
	} else {
		rows, err = s.db.Query(cols+" ORDER BY seq DESC LIMIT ?", taskID, limit+1)
	}
	if err != nil {
		return nil, false, 0, err
	}
	defer rows.Close()

	// limit 已在本函数开头被钳制在 [defaultLimit, maxLimit]，直接用常量上限
	// 做预分配容量：分配大小不再依赖外部传入值，杜绝内存分配放大；即使本次
	// 实际只取 limit 行，多出的容量也可忽略。
	logs = make([]TaskLog, 0, maxLimit)
	for rows.Next() {
		var l TaskLog
		if err = rows.Scan(&l.ID, &l.TaskID, &l.Seq, &l.Stream, &l.Content, &l.CreatedAt); err != nil {
			return nil, false, 0, err
		}
		logs = append(logs, l)
	}
	if err = rows.Err(); err != nil {
		return nil, false, 0, err
	}
	if len(logs) > limit {
		hasMore = true
		logs = logs[:limit]
	}
	for i, j := 0, len(logs)-1; i < j; i, j = i+1, j-1 {
		logs[i], logs[j] = logs[j], logs[i]
	}
	return logs, hasMore, total, nil
}
