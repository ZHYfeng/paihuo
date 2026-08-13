package exec

import (
	"fmt"
	"sort"
	"sync"

	"paihuo/internal/store"
)

// RuntimeCapability is an auditable feature a Runtime can provide. Role
// selection and Workflow policy reason about capabilities instead of CLI IDs.
type RuntimeCapability string

const (
	CapabilityBatch       RuntimeCapability = "batch"
	CapabilityInteractive RuntimeCapability = "interactive"
	CapabilitySession     RuntimeCapability = "session"
	CapabilitySkills      RuntimeCapability = "skills"
)

// RuntimeDescriptor contains stable catalog data. Health is deliberately
// separate from a Role: a Role describes responsibility, while a Runtime is
// merely one execution provider capable of satisfying it.
type RuntimeDescriptor struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Docs         string              `json:"docs"`
	Capabilities []RuntimeCapability `json:"capabilities"`
	Fields       []Field             `json:"fields"`
	Models       []ModelInfo         `json:"models,omitempty"`
	Healthy      bool                `json:"healthy"`
	Health       string              `json:"health,omitempty"`
}

// CommandSpec is the only process-level output exposed by RuntimeService.
// Keeping the original request out of the executor makes command translation
// independently contract-testable and replayable.
type CommandSpec struct {
	Bin      string   `json:"bin"`
	Args     []string `json:"args"`
	Env      []string `json:"-"`
	Warnings []string `json:"warnings,omitempty"`
}

// CommandRuntime is the seam used by RuntimeService. Production runtimes and
// FakeRuntime both satisfy it, so Task execution does not know any CLI flags.
type CommandRuntime interface {
	Descriptor() RuntimeDescriptor
	Prepare(ExecutionRequest) (CommandSpec, error)
}

// SessionRequest is the stable input for a structured, multi-turn session.
type SessionRequest struct {
	Role       store.RoleConfig
	SkillMount *RoleSkillMount
	SessionDir string
}

// SessionDriver exists only for Runtimes with structured message transport.
// Batch-only Runtimes are absent from this registry instead of returning
// feature-not-supported errors from a wide interface.
type SessionDriver interface {
	PrepareSession(SessionRequest) (CommandSpec, error)
	ExitCommand() string
}

// Provisioner owns install/login inspection for one Runtime. It is not needed
// to prepare or execute a Task.
type Provisioner interface {
	Inspect() ProvisionInfo
	InstallCommand() string
}

// RuntimeService is the deep module used by the application. It centralizes
// capability negotiation, catalog enrichment, command translation, sessions
// and provisioning behind a small interface.
type RuntimeService struct {
	mu           sync.RWMutex
	commands     map[string]CommandRuntime
	sessions     map[string]SessionDriver
	provisioners map[string]Provisioner
}

// NewRuntimeService builds an empty registry. Callers can register a fake or
// replay Runtime without changing TaskLifecycle or the executor.
func NewRuntimeService(runtimes ...CommandRuntime) *RuntimeService {
	s := &RuntimeService{
		commands:     make(map[string]CommandRuntime),
		sessions:     make(map[string]SessionDriver),
		provisioners: make(map[string]Provisioner),
	}
	for _, runtime := range runtimes {
		s.Register(runtime)
	}
	return s
}

// NewDefaultRuntimeService registers the five supported CLI Runtime adapters.
func NewDefaultRuntimeService() *RuntimeService {
	items := commandAdapters()
	runtimes := make([]CommandRuntime, 0, len(items))
	for _, adapter := range items {
		runtimes = append(runtimes, builtinCommandRuntime{adapter: adapter})
	}
	s := NewRuntimeService(runtimes...)
	for _, id := range []string{"pi", "omp"} {
		s.sessions[id] = builtinSessionDriver{id: id, runtime: s.commands[id]}
	}
	for _, adapter := range items {
		s.provisioners[adapter.ID()] = builtinProvisioner{adapter: adapter}
	}
	return s
}

func (s *RuntimeService) Register(runtime CommandRuntime) {
	d := runtime.Descriptor()
	if d.ID == "" {
		panic("runtime id must not be empty")
	}
	s.mu.Lock()
	s.commands[d.ID] = runtime
	s.mu.Unlock()
}

func (s *RuntimeService) RegisterSession(id string, driver SessionDriver) {
	s.mu.Lock()
	s.sessions[id] = driver
	s.mu.Unlock()
}

func (s *RuntimeService) Prepare(id string, request ExecutionRequest) (CommandSpec, error) {
	s.mu.RLock()
	runtime, ok := s.commands[id]
	s.mu.RUnlock()
	if !ok {
		return CommandSpec{}, fmt.Errorf("未知 Runtime: %s", id)
	}
	return runtime.Prepare(request)
}

func (s *RuntimeService) Has(id string) bool {
	s.mu.RLock()
	_, ok := s.commands[id]
	s.mu.RUnlock()
	return ok
}

func (s *RuntimeService) Supports(id string, capability RuntimeCapability) bool {
	for _, c := range s.Descriptor(id).Capabilities {
		if c == capability {
			return true
		}
	}
	return false
}

func (s *RuntimeService) Session(id string) (SessionDriver, bool) {
	s.mu.RLock()
	driver, ok := s.sessions[id]
	s.mu.RUnlock()
	return driver, ok
}

func (s *RuntimeService) Descriptor(id string) RuntimeDescriptor {
	s.mu.RLock()
	runtime := s.commands[id]
	s.mu.RUnlock()
	if runtime == nil {
		return RuntimeDescriptor{}
	}
	return runtime.Descriptor()
}

// Catalog probes health and model capabilities concurrently in the existing
// cached discoverers, then returns a deterministic order for HTTP and tests.
func (s *RuntimeService) Catalog() []RuntimeDescriptor {
	s.mu.RLock()
	runtimes := make([]CommandRuntime, 0, len(s.commands))
	for _, runtime := range s.commands {
		runtimes = append(runtimes, runtime)
	}
	s.mu.RUnlock()

	out := make([]RuntimeDescriptor, len(runtimes))
	var wg sync.WaitGroup
	for i, runtime := range runtimes {
		wg.Add(1)
		go func(i int, runtime CommandRuntime) {
			defer wg.Done()
			out[i] = runtime.Descriptor()
		}(i, runtime)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (s *RuntimeService) Provisioning() []ProvisionInfo {
	s.mu.RLock()
	items := make([]Provisioner, 0, len(s.provisioners))
	for _, provisioner := range s.provisioners {
		items = append(items, provisioner)
	}
	s.mu.RUnlock()
	out := make([]ProvisionInfo, 0, len(items))
	for _, provisioner := range items {
		out = append(out, provisioner.Inspect())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (s *RuntimeService) InstallCommand(id string) (string, bool) {
	s.mu.RLock()
	provisioner, ok := s.provisioners[id]
	s.mu.RUnlock()
	if !ok {
		return "", false
	}
	return provisioner.InstallCommand(), true
}

type builtinCommandRuntime struct{ adapter commandAdapter }

func (r builtinCommandRuntime) Descriptor() RuntimeDescriptor {
	d := RuntimeDescriptor{
		ID: r.adapter.ID(), Name: r.adapter.Name(), Docs: r.adapter.Docs(),
		Capabilities: []RuntimeCapability{CapabilityBatch, CapabilitySkills},
		Fields:       Enrich(r.adapter.Schema()),
		Models:       ModelCatalog(r.adapter),
	}
	if r.adapter.ID() == "pi" || r.adapter.ID() == "omp" {
		d.Capabilities = append(d.Capabilities, CapabilityInteractive, CapabilitySession)
	}
	if _, err := r.adapter.Detect(); err != nil {
		d.Health = err.Error()
	} else {
		d.Healthy = true
	}
	return d
}

func (r builtinCommandRuntime) Prepare(request ExecutionRequest) (CommandSpec, error) {
	bin, err := r.adapter.Detect()
	if err != nil {
		return CommandSpec{}, err
	}
	_, args, env, err := r.adapter.Build(request)
	if err != nil {
		return CommandSpec{}, err
	}
	return CommandSpec{Bin: bin, Args: args, Env: env, Warnings: r.adapter.Warnings(request)}, nil
}

type builtinSessionDriver struct {
	id      string
	runtime CommandRuntime
}

func (d builtinSessionDriver) PrepareSession(request SessionRequest) (CommandSpec, error) {
	descriptor := d.runtime.Descriptor()
	if !descriptor.Healthy {
		return CommandSpec{}, fmt.Errorf("Runtime %s 不可用: %s", d.id, descriptor.Health)
	}
	var args []string
	var err error
	if d.id == "omp" {
		args, err = BuildOmpRPCSessionArgs(request.Role, request.SkillMount, request.SessionDir)
	} else {
		var paths []string
		if request.SkillMount != nil {
			paths = request.SkillMount.SkillPaths
		}
		args, err = BuildPiRPCSessionArgs(request.Role, paths, request.SessionDir)
	}
	if err != nil {
		return CommandSpec{}, err
	}
	return CommandSpec{Bin: descriptor.ID, Args: args, Env: MergeEnv(request.Role.Env)}, nil
}

func (d builtinSessionDriver) ExitCommand() string {
	if d.id == "pi" {
		return "/quit"
	}
	return "/exit"
}

type builtinProvisioner struct{ adapter commandAdapter }

func (p builtinProvisioner) Inspect() ProvisionInfo { return inspectProvision(p.adapter) }
func (p builtinProvisioner) InstallCommand() string { return InstallCommands[p.adapter.ID()] }

// FakeRuntime is a deterministic adapter for TaskLifecycle and Workflow tests.
// ReplayRuntime can use the same type with a prepared sequence of CommandSpecs.
type FakeRuntime struct {
	RuntimeDescriptor RuntimeDescriptor
	Command           CommandSpec
	Err               error
}

func (f *FakeRuntime) Descriptor() RuntimeDescriptor { return f.RuntimeDescriptor }
func (f *FakeRuntime) Prepare(ExecutionRequest) (CommandSpec, error) {
	return f.Command, f.Err
}
