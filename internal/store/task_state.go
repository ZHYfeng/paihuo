package store

func (s *Store) UpdateTmuxLogOffset(id int64, offset int64) error {
	_, err := s.db.Exec("UPDATE tasks SET tmux_log_offset=? WHERE id=?", offset, id)
	return err
}

// UpdateTerminalSize 记录交互任务终端最近一次同步到 tmux 窗口的尺寸。
// 任务结束后前端按此尺寸重放最后画面（缩放适配容器），而不是按浏览器
// 容器 fit 重排导致画面错位/大片留白。不更新 updated_at（同日志偏移）。
func (s *Store) UpdateTerminalSize(id int64, cols, rows int) error {
	_, err := s.db.Exec("UPDATE tasks SET terminal_cols=?, terminal_rows=? WHERE id=?", cols, rows, id)
	return err
}

// ClaimTask 原子领取：queued -> claimed，返回是否领取成功。
func (s *Store) ClaimTask(id int64) (bool, error) {
	res, err := s.db.Exec("UPDATE tasks SET status='claimed', started_at=?, updated_at=?, revision=revision+1 WHERE id=? AND status='queued'", Now(), Now(), id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// StartTask 原子开跑：claimed -> running。若返回 false 说明领取后任务已被
// 取消/删除（与派发存在竞态），调用方应放弃执行而不是覆盖终态。
func (s *Store) StartTask(id int64) (bool, error) {
	res, err := s.db.Exec("UPDATE tasks SET status='running', started_at=?, updated_at=?, revision=revision+1 WHERE id=? AND status='claimed'", Now(), Now(), id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}
