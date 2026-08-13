.DEFAULT_GOAL := help

VERSION ?= dev
BUILD_DIR := bin
GO_BUILD_FLAGS ?= -trimpath -buildvcs=true
LDFLAGS ?= -X main.version=$(VERSION)
GO_PACKAGES := ./cmd/... ./internal/...

.PHONY: help build release test test-race test-runtime vet fmt fmt-check mod-tidy-check frontend frontend-check frontend-test e2e check clean

help: ## Show available development commands.
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "%-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

build: ## Build a development binary at bin/paihuo.
	@mkdir -p $(BUILD_DIR)
	go build $(GO_BUILD_FLAGS) -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/paihuo ./cmd/paihuo

release: ## Build a smaller release binary; set VERSION=vX.Y.Z.
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 go build $(GO_BUILD_FLAGS) -ldflags "-s -w $(LDFLAGS)" -o $(BUILD_DIR)/paihuo ./cmd/paihuo

test: ## Run the Go test suite.
	go test $(GO_PACKAGES)

test-race: ## Run Go tests with the race detector.
	go test -race $(GO_PACKAGES)

test-runtime: ## Run opt-in smoke tests against the installed Pi Runtime.
	PAIHUO_REAL_RUNTIME_TESTS=1 go test ./internal/session ./internal/server -run 'TestLifecycleWithRealPi|TestSessionAPI'

vet: ## Run Go's static analyzer.
	go vet $(GO_PACKAGES)

fmt: ## Format all Go source files.
	gofmt -w $$(find . -type f -name '*.go' -not -path './vendor/*')

fmt-check: ## Fail when Go source files are not gofmt-formatted.
	@unformatted="$$(gofmt -l $$(find . -type f -name '*.go' -not -path './vendor/*'))"; \
	if [ -n "$$unformatted" ]; then \
		echo "The following files need gofmt:" >&2; \
		echo "$$unformatted" >&2; \
		exit 1; \
	fi

mod-tidy-check: ## Verify go.mod and go.sum are tidy without modifying them.
	go mod tidy -diff

frontend: ## Build the React application embedded in the Go binary.
	./scripts/build-frontend.sh

frontend-check: ## Typecheck, lint, and verify the embedded React build.
	npm run typecheck
	npm run lint
	./scripts/build-frontend.sh --check

frontend-test: ## Run frontend component tests.
	npm test

e2e: ## Run browser end-to-end checks against an already-running server.
	./scripts/e2e.sh

check: fmt-check mod-tidy-check frontend-check frontend-test vet test build ## Run the full quality gate.

clean: ## Remove locally built artifacts.
	rm -rf ./bin
