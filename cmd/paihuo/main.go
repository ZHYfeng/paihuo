// 派活（paihuo）—— 个人自托管 agent 调度平台。
// 单二进制：paihuo serve --addr 127.0.0.1:8080 --db paihuo.db
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

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
	_ = httpSrv.Shutdown(context.Background())
}
