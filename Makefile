.DEFAULT_GOAL := help

VERSION ?= dev
BUILD_DIR := bin
GO_BUILD_FLAGS ?= -trimpath -buildvcs=true
LDFLAGS ?= -X main.version=$(VERSION)

.PHONY: help build release test test-race vet fmt fmt-check mod-tidy-check frontend frontend-check e2e check clean

help: ## Show available development commands.
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "%-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

build: ## Build a development binary at bin/paihuo.
	@mkdir -p $(BUILD_DIR)
	go build $(GO_BUILD_FLAGS) -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/paihuo ./cmd/paihuo

release: ## Build a smaller release binary; set VERSION=vX.Y.Z.
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 go build $(GO_BUILD_FLAGS) -ldflags "-s -w $(LDFLAGS)" -o $(BUILD_DIR)/paihuo ./cmd/paihuo

test: ## Run the Go test suite.
	go test ./...

test-race: ## Run Go tests with the race detector.
	go test -race ./...

vet: ## Run Go's static analyzer.
	go vet ./...

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

frontend: ## Rebuild the checked-in frontend bundle (requires npm ci once).
	./scripts/build-frontend.sh

frontend-check: ## Verify that the checked-in frontend bundle is current.
	./scripts/build-frontend.sh --check

e2e: ## Run browser end-to-end checks against an already-running server.
	./scripts/e2e.sh

check: fmt-check mod-tidy-check frontend-check vet test build ## Run the full fast quality gate.

clean: ## Remove locally built artifacts.
	rm -rf ./bin
