package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"paihuo/internal/events"
	paiexec "paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/store"
)

func newSecurityTestServer(t *testing.T, token string) *Server {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	root := t.TempDir()
	hub := events.NewHub()
	executor := paiexec.New(st, hub, filepath.Join(root, "sessions"), filepath.Join(root, "paihuo.db"))
	return New(st, hub, executor, sched.New(st, hub, executor), token, filepath.Join(root, "skills"))
}

func TestHandlerAuthenticationAndSecurityHeaders(t *testing.T) {
	s := newSecurityTestServer(t, "test-token")
	s.SetSecureCookies(true)
	h := s.Handler()

	unauthorized := httptest.NewRecorder()
	h.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/api/tasks", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("未登录 API 应返回 401，得到 %d: %s", unauthorized.Code, unauthorized.Body.String())
	}
	assertSecurityHeaders(t, unauthorized.Header(), "no-store")

	form := url.Values{"token": {"test-token"}}
	loginReq := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(form.Encode()))
	loginReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginReq)
	if login.Code != http.StatusFound {
		t.Fatalf("登录应重定向，得到 %d: %s", login.Code, login.Body.String())
	}
	assertSecurityHeaders(t, login.Header(), "no-store")
	cookies := login.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("登录应签发一个会话 cookie，得到 %d 个", len(cookies))
	}
	cookie := cookies[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("会话 cookie 安全属性错误: %+v", cookie)
	}
	if parts := strings.Split(cookie.Value, "."); len(parts) != 3 {
		t.Fatalf("会话 cookie 格式错误: %q", cookie.Value)
	}

	authorizedReq := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	authorizedReq.AddCookie(cookie)
	authorized := httptest.NewRecorder()
	h.ServeHTTP(authorized, authorizedReq)
	if authorized.Code != http.StatusOK {
		t.Fatalf("有效会话应可访问 API，得到 %d: %s", authorized.Code, authorized.Body.String())
	}
	assertSecurityHeaders(t, authorized.Header(), "no-store")
	refreshed := authorized.Result().Cookies()
	if len(refreshed) != 1 || refreshed[0].Value == cookie.Value {
		t.Fatal("已认证请求应轮换为新的会话 nonce")
	}

	badCookie := *cookie
	badCookie.Value += "x"
	badReq := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	badReq.AddCookie(&badCookie)
	bad := httptest.NewRecorder()
	h.ServeHTTP(bad, badReq)
	if bad.Code != http.StatusUnauthorized {
		t.Fatalf("篡改会话应返回 401，得到 %d", bad.Code)
	}

	asset := httptest.NewRecorder()
	h.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/static/app.css", nil))
	if asset.Code != http.StatusOK {
		t.Fatalf("静态资源应可访问，得到 %d", asset.Code)
	}
	assertSecurityHeaders(t, asset.Header(), "no-cache")
}

func TestReadJSONRejectsAmbiguousAndOversizedBodies(t *testing.T) {
	t.Run("multiple JSON values", func(t *testing.T) {
		r := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"first"}{"name":"second"}`))
		var dst struct {
			Name string `json:"name"`
		}
		if readJSON(r, req, &dst) {
			t.Fatal("不应接受多个 JSON 值")
		}
		if r.Code != http.StatusBadRequest {
			t.Fatalf("状态码应为 400，得到 %d", r.Code)
		}
	})

	t.Run("unknown fields", func(t *testing.T) {
		r := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"ok","extra":true}`))
		var dst struct {
			Name string `json:"name"`
		}
		if readJSON(r, req, &dst) {
			t.Fatal("不应静默接受未知字段")
		}
		if r.Code != http.StatusBadRequest {
			t.Fatalf("状态码应为 400，得到 %d", r.Code)
		}
	})

	t.Run("oversized body", func(t *testing.T) {
		r := httptest.NewRecorder()
		body := `{"name":"` + strings.Repeat("x", maxJSONBody) + `"}`
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		var dst map[string]string
		if readJSON(r, req, &dst) {
			t.Fatal("不应接受超过上限的请求体")
		}
		if r.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("状态码应为 413，得到 %d: %s", r.Code, r.Body.String())
		}
	})
}

func assertSecurityHeaders(t *testing.T, h http.Header, cacheControl string) {
	t.Helper()
	for key, want := range map[string]string{
		"Cache-Control":                cacheControl,
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "DENY",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
	} {
		if got := h.Get(key); got != want {
			t.Errorf("%s = %q，期望 %q", key, got, want)
		}
	}
	if !strings.Contains(h.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Errorf("未设置 frame-ancestors CSP: %q", h.Get("Content-Security-Policy"))
	}
}
