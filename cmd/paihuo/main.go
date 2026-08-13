// 派活（paihuo）—— 个人自托管 agent 调度平台。
// 单二进制：paihuo serve --addr 127.0.0.1:8080 --db paihuo.db
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"paihuo/internal/artifact"
	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/server"
	"paihuo/internal/store"
	"paihuo/internal/workspace"
)

// version is set at release build time with -ldflags "-X main.version=<version>".
var version = "dev"

func main() {
	var addr, db, token string
	var showVersion, secureCookie bool
	flag.StringVar(&addr, "addr", "127.0.0.1:8080", "监听地址（公开监听时必须设置访问令牌）")
	flag.StringVar(&db, "db", "paihuo.db", "SQLite 数据库路径")
	flag.StringVar(&token, "token", "", "访问令牌（也可用环境变量 PAIHUO_TOKEN）")
	flag.BoolVar(&secureCookie, "secure-cookie", false, "为 HTTPS 反向代理部署将会话 cookie 标记为 Secure")
	flag.BoolVar(&showVersion, "version", false, "输出版本后退出")
	flag.Parse()
	if showVersion {
		fmt.Println(version)
		return
	}

	if token == "" {
		token = os.Getenv("PAIHUO_TOKEN")
	}
	if token == "" {
		if err := validateListenSecurity(addr, token); err != nil {
			log.Fatal(err)
		}
		log.Printf("⚠ 未设置访问令牌：仅允许来自本机的访问。若需公开监听，请设置 --token 或 PAIHUO_TOKEN。")
	}

	st, err := store.Open(db)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer st.Close()

	hub := events.NewEventStream(st)
	sessionsRoot := filepath.Join(filepath.Dir(db), "sessions")
	ex := exec.New(st, hub, sessionsRoot, db)
	sc := sched.New(st, hub, ex)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ex.Start(ctx)
	sc.Start(ctx)
	go autoCleanup(ctx, st, ex, sessionsRoot)

	srv := server.New(st, hub, ex, sc, token, filepath.Join(filepath.Dir(db), "skills"))
	srv.SetSecureCookies(secureCookie)
	srv.Start(ctx)
	// 不设置 WriteTimeout：SSE 是长连接，写超时会中断正常的实时日志流。
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	// 模型/能力目录属于当前 Linux 主机，而非角色数据库：每次服务启动
	// （即重新部署）立即重查，此后每 7 天重查一次。角色选择的 model /
	// thinking 仍只保存在 SQLite，不会被发现结果覆盖。
	go refreshModelCatalogs(ctx)

	serveErr := make(chan error, 1)
	go func() {
		log.Printf("派活已启动: http://%s（数据库 %s%s）", addr, db, map[bool]string{true: "，已开启鉴权", false: ""}[token != ""])
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serveErr <- err
		}
	}()

	select {
	case <-ctx.Done():
	case err := <-serveErr:
		log.Printf("服务异常: %v", err)
		stop()
	}
	log.Println("正在关闭...")
	// 带超时关闭：SSE 等长连接不会自己结束，超时后强制退出
	shCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shCtx)
	log.Println("已关闭")
}

// isLoopbackAddr reports whether an HTTP listen address only accepts local
// connections. An empty host (":8080") and unspecified addresses are public.
func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func validateListenSecurity(addr, token string) error {
	if token == "" && !isLoopbackAddr(addr) {
		return fmt.Errorf("拒绝在公开地址 %q 无鉴权启动；请设置 --token 或 PAIHUO_TOKEN", addr)
	}
	return nil
}

// refreshModelCatalogs 在启动和固定周期从本机各 CLI 探测模型/能力。手动刷新
// 由 POST /api/v1/runtimes/refresh 使用同一个 exec.RefreshModelCatalogs 流程。
func refreshModelCatalogs(ctx context.Context) {
	run := func(reason string) {
		started := time.Now()
		exec.RefreshModelCatalogs()
		log.Printf("已从 Linux 主机刷新 Runtime 模型/能力目录（%s，耗时 %s）", reason, time.Since(started).Round(time.Millisecond))
	}
	run("服务启动")

	ticker := time.NewTicker(7 * 24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run("7 天定期刷新")
		}
	}
}

// autoCleanup 每小时执行：清理超期任务、无引用 Artifact、孤儿 Runtime 会话
// 和过期任务 worktree。
func autoCleanup(ctx context.Context, st *store.Store, ex *exec.Executor, sessionsRoot string) {
	artifactStore, artifactErr := artifact.NewLocalStore(filepath.Join(filepath.Dir(sessionsRoot), "artifacts"))
	if artifactErr != nil {
		log.Printf("自动清理：ArtifactStore 不可用: %v", artifactErr)
	}
	run := func() {
		days := "0"
		if v, err := st.GetSetting("retention_days"); err == nil && v != "" {
			days = v
		}
		if n, err := strconv.Atoi(days); err == nil && n > 0 {
			before := time.Now().Add(-time.Duration(n) * 24 * time.Hour).UTC().Format(time.RFC3339)
			if deleted, locators, err := st.CleanupTasks(nil, before); err == nil {
				if deleted > 0 {
					log.Printf("自动清理：删除 %d 条超过 %d 天的任务", deleted, n)
				}
				if artifactStore != nil {
					for _, locator := range locators {
						if count, countErr := st.CountArtifactsByLocator(locator); countErr == nil && count == 0 {
							_ = artifactStore.Delete(ctx, locator)
						}
					}
				}
			}
		}
		// worktree 保留天数（默认 7 天）
		wtDays := 7
		if v, err := st.GetSetting("worktree_retention_days"); err == nil && v != "" {
			if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				wtDays = n
			}
		}
		if tasks, err := st.ListTasksForCleanup(); err == nil {
			if n := workspace.Cleanup(sessionsRoot, wtDays, tasks); n > 0 {
				log.Printf("自动清理：移除 %d 个过期任务 worktree", n)
			}
		}
		if n, err := ex.CleanupOrphanTaskSessions(); err == nil && n > 0 {
			log.Printf("自动清理：移除 %d 个孤儿 Runtime 会话", n)
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
