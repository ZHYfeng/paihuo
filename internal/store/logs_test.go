package store

import (
	"fmt"
	"testing"
)

func TestListLogsPageLoadsNewestWindowAndOlderWindows(t *testing.T) {
	s := openTest(t)
	id := mustTask(t, s, "logs", nil, StatusSucceeded, "")
	for i := 1; i <= 5; i++ {
		if _, err := s.AppendLog(TaskLog{TaskID: id, Stream: "out", Content: fmt.Sprintf("line-%d", i)}); err != nil {
			t.Fatal(err)
		}
	}

	page, more, total, err := s.ListLogsPage(id, 0, 2)
	if err != nil || total != 5 || !more || len(page) != 2 || page[0].Seq != 4 || page[1].Seq != 5 {
		t.Fatalf("最新日志窗口异常: page=%+v more=%v total=%d err=%v", page, more, total, err)
	}
	page, more, _, err = s.ListLogsPage(id, page[0].Seq, 2)
	if err != nil || !more || len(page) != 2 || page[0].Seq != 2 || page[1].Seq != 3 {
		t.Fatalf("向前翻页异常: page=%+v more=%v err=%v", page, more, err)
	}
	page, more, _, err = s.ListLogsPage(id, page[0].Seq, 2)
	if err != nil || more || len(page) != 1 || page[0].Seq != 1 {
		t.Fatalf("最后一页异常: page=%+v more=%v err=%v", page, more, err)
	}
}
