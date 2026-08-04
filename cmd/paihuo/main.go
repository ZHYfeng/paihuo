// 派活（paihuo）—— 个人自托管 agent 调度平台。
// 单二进制：paihuo serve --addr 127.0.0.1:8080 --db paihuo.db
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/server"
	"paihuo/internal/store"
)

func main() {
	var addr, db, token string
	flag.StringVar(&addr, "addr", "0.0.0.0:8080", "监听地址（部署在服务器时保持 0.0.0.0 供浏览器访问）")
	flag.StringVar(&db, "db", "paihuo.db", "SQLite 数据库路径")
	flag.StringVar(&token, "token", "", "访问令牌（空则不鉴权；也可用环境变量 PAIHUO_TOKEN）")
	flag.Parse()

	if token == "" {
		token = os.Getenv("PAIHUO_TOKEN")
	}
	if token == "" {
		log.Printf("⚠ 警告：未设置访问令牌（--token 或 PAIHUO_TOKEN）。服务暴露在网络上时任何人都能操作，强烈建议设置。")
	}

	st, err := store.Open(db)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer st.Close()

	hub := events.NewHub()
	ex := exec.New(st, hub)
	sc := sched.New(st, hub, ex)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ex.Start(ctx)
	sc.Start(ctx)
	go autoCleanup(ctx, st)

	srv := server.New(st, hub, ex, sc, token)
	httpSrv := &http.Server{Addr: addr, Handler: srv.Handler()}

	go func() {
		log.Printf("派活已启动: http://%s（数据库 %s%s）", addr, db, map[bool]string{true: "，已开启鉴权", false: ""}[token != ""])
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("服务异常: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("正在关闭...")
	// 带超时关闭：SSE 等长连接不会自己结束，超时后强制退出
	shCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shCtx)
	log.Println("已关闭")
}

// autoCleanup 每小时执行：按 retention_days 设置清理终态历史，并删除孤儿会话目录。
func autoCleanup(ctx context.Context, st *store.Store) {
	run := func() {
		days := "0"
		if v, err := st.GetSetting("retention_days"); err == nil && v != "" {
			days = v
		}
		if n, err := strconv.Atoi(days); err == nil && n > 0 {
			before := time.Now().Add(-time.Duration(n) * 24 * time.Hour).UTC().Format(time.RFC3339)
			if deleted, err := st.CleanupTasks(nil, before); err == nil && deleted > 0 {
				log.Printf("自动清理：删除 %d 条超过 %d 天的历史任务", deleted, n)
			}
		}
		// 清理没有对应任务的会话目录
		sessRoot := filepath.Join(os.TempDir(), "paihuo-sessions")
		entries, err := os.ReadDir(sessRoot)
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			var id int64
			if _, err := fmt.Sscanf(e.Name(), "task-%d", &id); err != nil {
				continue
			}
			exists, err := st.HasTask(id)
			if err == nil && !exists {
				_ = os.RemoveAll(filepath.Join(sessRoot, e.Name()))
			}
		}
	}
	run()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}
