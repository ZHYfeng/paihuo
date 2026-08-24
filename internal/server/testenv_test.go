package server

import (
	"path/filepath"
	"testing"

	"paihuo/internal/application"
	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/sched"
	"paihuo/internal/session"
	"paihuo/internal/store"
)

type testEnv struct {
	server       *Server
	store        *store.Store
	hub          *events.EventStream
	executor     *exec.Executor
	root         string
	sessionsRoot string
	skillsDir    string
}

type testEnvConfig struct {
	store           *store.Store
	databasePath    string
	root            string
	persistentHub   bool
	executor        *testExecutorConfig
	sessionsRoot    string
	sessionInstance string
	skillsDir       string
	token           string
}

type testExecutorConfig struct {
	sessionsRoot string
	instanceID   string
	socket       string
}

type testOpt func(*testEnvConfig)

func withTestStore(st *store.Store) testOpt {
	return func(cfg *testEnvConfig) { cfg.store = st }
}

func withTestDatabase(path string) testOpt {
	return func(cfg *testEnvConfig) { cfg.databasePath = path }
}

func withTestRoot(root string) testOpt {
	return func(cfg *testEnvConfig) { cfg.root = root }
}

func withPersistentEventStream() testOpt {
	return func(cfg *testEnvConfig) { cfg.persistentHub = true }
}

func withTestExecutor(sessionsRoot, instanceID, socket string) testOpt {
	return func(cfg *testEnvConfig) {
		cfg.executor = &testExecutorConfig{sessionsRoot: sessionsRoot, instanceID: instanceID, socket: socket}
	}
}

func withTestSession(sessionsRoot, instanceID string) testOpt {
	return func(cfg *testEnvConfig) {
		cfg.sessionsRoot = sessionsRoot
		cfg.sessionInstance = instanceID
	}
}

func withTestSkillsDir(skillsDir string) testOpt {
	return func(cfg *testEnvConfig) { cfg.skillsDir = skillsDir }
}

func withTestToken(token string) testOpt {
	return func(cfg *testEnvConfig) { cfg.token = token }
}

func newTestServer(t *testing.T, opts ...testOpt) *testEnv {
	t.Helper()
	cfg := testEnvConfig{databasePath: ":memory:"}
	for _, opt := range opts {
		opt(&cfg)
	}
	if cfg.root == "" {
		if cfg.skillsDir != "" {
			cfg.root = filepath.Dir(cfg.skillsDir)
		} else {
			cfg.root = t.TempDir()
		}
	}
	if cfg.skillsDir == "" {
		cfg.skillsDir = filepath.Join(cfg.root, "skills")
	}
	if cfg.sessionsRoot == "" {
		cfg.sessionsRoot = t.TempDir()
	}
	if cfg.sessionInstance == "" {
		cfg.sessionInstance = t.TempDir()
	}

	st := cfg.store
	if st == nil {
		var err error
		st, err = store.Open(cfg.databasePath)
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _ = st.Close() })

	var hub *events.EventStream
	if cfg.persistentHub {
		hub = events.NewEventStream(st)
	} else {
		hub = events.NewEventStream()
	}
	t.Cleanup(hub.Close)

	var executor *exec.Executor
	if cfg.executor != nil {
		executor = exec.NewForTest(st, hub, cfg.executor.sessionsRoot, cfg.executor.instanceID, cfg.executor.socket)
	}
	sess := session.New(st, hub, executor, cfg.sessionsRoot, cfg.sessionInstance)
	runtimes := exec.NewDefaultRuntimeService()
	if executor != nil {
		runtimes = executor.RuntimeService()
	}
	workflows := application.NewWorkflowService(st, runtimes, executor, hub)
	scheduler := sched.New(st, hub, executor, sess, workflows)
	server := New(st, hub, executor, scheduler, sess, workflows, cfg.token, cfg.skillsDir)

	return &testEnv{
		server:       server,
		store:        st,
		hub:          hub,
		executor:     executor,
		root:         cfg.root,
		sessionsRoot: cfg.sessionsRoot,
		skillsDir:    cfg.skillsDir,
	}
}
