// dshhost：DeepSeek Harness 会话宿主进程池。
//
// 每个 dsh 会话由常驻的 `dsh --profile web` HTTP 宿主承载（原生 ApiProxy，
// 不需要 TTY/tmux）。两个按权限模式路由的宿主：
//   - full  → DSH_PERMISSION_MODE=danger-full-access（无审批、无沙箱）
//   - review → DSH_PERMISSION_MODE=workspace-write（沙箱 + 人工审批，审批事件
//     走 /api/respond 在会话页应答）
//
// 宿主懒启动（首次会话触发），常驻到 Manager.Stop；宿主崩溃由 API 调用失败
// 暴露，会话按退出处理，恢复时自动重连。
package session

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"paihuo/internal/store"
)

const (
	// 两个宿主默认监听端口。端口可被环境变量覆盖（PaiHuo 单实例自托管，
	// 固定端口便于运维；冲突会在健康检查中暴露为明确错误）。
	dshFullHostPort   = 17560
	dshReviewHostPort = 17561
	dshHostBootLimit  = 90 * time.Second // 首次健康检查等待上限（dsh web 启动较慢）
)

// dshPerm 是会话可路由的权限模式（与任务 Perm 对应）。
type dshPerm string

const (
	dshPermFull   dshPerm = "full"
	dshPermReview dshPerm = "review"
)

// dshPermOf 把 store 权限模式归一化为宿主路由键；未知值按 review 保守处理。
func dshPermOf(perm string) dshPerm {
	if perm == store.PermFull {
		return dshPermFull
	}
	return dshPermReview
}

// dshHostSpec 描述一个宿主的启动参数。
type dshHostSpec struct {
	perm       dshPerm
	port       int
	permission string // DSH_PERMISSION_MODE 值
	logPath    string
}

// dshHostPool 管理 full/review 两个 dsh web 宿主进程。
type dshHostPool struct {
	runtimeSessions string // <sessionsRoot>/.runtime-sessions（日志落此处）

	mu     sync.Mutex
	hosts  map[dshPerm]*dshHost
	stopCh chan struct{}
	done   sync.WaitGroup
}

func newDSHHostPool(runtimeSessions string) *dshHostPool {
	return &dshHostPool{
		runtimeSessions: runtimeSessions,
		hosts:           make(map[dshPerm]*dshHost),
		stopCh:          make(chan struct{}),
	}
}

// dshHost 是一个宿主的运行时状态。
type dshHost struct {
	spec    dshHostSpec
	cmd     *exec.Cmd
	api     *dshAPI
	mu      sync.Mutex // healthy 守卫
	healthy bool
}

func (p *dshHostPool) specFor(perm dshPerm) dshHostSpec {
	port := dshFullHostPort
	permission := "danger-full-access"
	if perm == dshPermReview {
		port = dshReviewHostPort
		permission = "workspace-write"
	}
	// 环境变量覆盖端口（多实例部署错开）。
	if v := strings.TrimSpace(os.Getenv("PAIHUO_DSH_FULL_PORT")); v != "" && perm == dshPermFull {
		fmt.Sscanf(v, "%d", &port)
	}
	if v := strings.TrimSpace(os.Getenv("PAIHUO_DSH_REVIEW_PORT")); v != "" && perm == dshPermReview {
		fmt.Sscanf(v, "%d", &port)
	}
	return dshHostSpec{
		perm:       perm,
		port:       port,
		permission: permission,
		logPath:    filepath.Join(p.runtimeSessions, fmt.Sprintf("dsh-host-%s.log", perm)),
	}
}

// addr 返回某权限模式的宿主地址；首次调用时惰性启动宿主并等待就绪。
func (p *dshHostPool) addr(ctx context.Context, perm dshPerm) (dshHostAddr, error) {
	host, err := p.host(ctx, perm)
	if err != nil {
		return dshHostAddr{}, err
	}
	return dshHostAddr{baseURL: fmt.Sprintf("http://127.0.0.1:%d", host.spec.port)}, nil
}

// host 返回（必要时启动）某权限模式的宿主。
func (p *dshHostPool) host(ctx context.Context, perm dshPerm) (*dshHost, error) {
	p.mu.Lock()
	h := p.hosts[perm]
	p.mu.Unlock()
	if h != nil {
		if h.ready() {
			return h, nil
		}
		// 记录在册但未就绪（进程退出/健康检查失败）→ 终止并重新启动。
		h.stop()
		p.mu.Lock()
		if p.hosts[perm] == h {
			delete(p.hosts, perm)
		}
		p.mu.Unlock()
	}
	return p.boot(ctx, perm)
}

// boot 启动宿主并等待健康检查通过（不持锁：启动耗时数秒，避免卡住其它路径）。
func (p *dshHostPool) boot(ctx context.Context, perm dshPerm) (*dshHost, error) {
	spec := p.specFor(perm)
	host := &dshHost{spec: spec}
	host.spawn()
	err := host.waitHealthy(ctx)
	if err != nil {
		host.stop()
		return nil, fmt.Errorf("dsh %s 宿主启动失败: %w", perm, err)
	}
	p.mu.Lock()
	if old := p.hosts[perm]; old != nil {
		old.stop() // 竞态：另一路已启动成功，弃用本实例
	}
	p.hosts[perm] = host
	p.mu.Unlock()
	log.Printf("↻ dsh %s 宿主就绪（127.0.0.1:%d，权限 %s）", perm, spec.port, spec.permission)
	return host, nil
}

// spawn 启动 `dsh --profile web --host 127.0.0.1 --port <n>` 进程。
func (h *dshHost) spawn() {
	if err := os.MkdirAll(filepath.Dir(h.spec.logPath), 0o755); err != nil {
		log.Printf("⚠ 创建 dsh 宿主日志目录失败: %v", err)
	}
	f, err := os.OpenFile(h.spec.logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("⚠ 打开 dsh 宿主日志失败: %v", err)
	}
	cmd := exec.Command("dsh", "--profile", "web", "--host", "127.0.0.1", "--port", fmt.Sprintf("%d", h.spec.port))
	cmd.Env = append(os.Environ(), "DSH_PERMISSION_MODE="+h.spec.permission)
	if f != nil {
		cmd.Stdout = f
		cmd.Stderr = f
	}
	if err := cmd.Start(); err != nil {
		if f != nil {
			f.Close()
		}
		log.Printf("⚠ 启动 dsh %s 宿主失败: %v", h.spec.perm, err)
		h.cmd = nil
		return
	}
	h.cmd = cmd
	if f != nil {
		go func() { _ = cmd.Wait(); f.Close() }()
	}
}

// ready 报告宿主是否已通过健康检查。
func (h *dshHost) ready() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.healthy && h.cmd != nil && h.cmd.ProcessState == nil
}

// waitHealthy 轮询 llm.providers 直到宿主就绪。
func (h *dshHost) waitHealthy(ctx context.Context) error {
	h.api = newDSHAPI(dshHostAddr{baseURL: fmt.Sprintf("http://127.0.0.1:%d", h.spec.port)})
	deadline := time.Now().Add(dshHostBootLimit)
	client := &http.Client{Timeout: 3 * time.Second}
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
		body := bytes.NewBufferString(`{"type":"client-request","rpcId":"boot","method":"llm.providers","payload":{}}`)
		req, err := http.NewRequest(http.MethodPost, h.api.baseURL+"/api/llm.providers", body)
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		if resp, err := client.Do(req); err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				h.mu.Lock()
				h.healthy = true
				h.mu.Unlock()
				return nil
			}
		}
		if h.cmd != nil && h.cmd.ProcessState != nil {
			return fmt.Errorf("dsh 宿主进程已退出（日志: %s）", h.spec.logPath)
		}
	}
	return fmt.Errorf("等待 dsh 宿主健康检查超时（%v，日志: %s）", dshHostBootLimit, h.spec.logPath)
}

// stop 终止宿主进程。
func (h *dshHost) stop() {
	if h.cmd != nil && h.cmd.Process != nil {
		_ = h.cmd.Process.Kill()
	}
	h.mu.Lock()
	h.healthy = false
	h.mu.Unlock()
}

// StopAll 停止全部宿主（服务退出时调用；幂等）。
func (p *dshHostPool) StopAll() {
	p.mu.Lock()
	hosts := make([]*dshHost, 0, len(p.hosts))
	for _, h := range p.hosts {
		hosts = append(hosts, h)
	}
	p.hosts = make(map[dshPerm]*dshHost)
	p.mu.Unlock()
	for _, h := range hosts {
		h.stop()
		log.Printf("↻ dsh %s 宿主已停止", h.spec.perm)
	}
}
