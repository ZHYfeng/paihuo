package server

import (
	"bufio"
	"bytes"
	"fmt"
	"sort"
	"strings"
	"testing"
)

func TestOpenAPIContractUsesOpenAPI31AndDomainVocabulary(t *testing.T) {
	body, err := apiContract.ReadFile("openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	contract := string(body)
	for _, required := range []string{"openapi: 3.1.0", "url: /api/v1", "Idempotency-Key", "If-Match", "role_id"} {
		if !strings.Contains(contract, required) {
			t.Fatalf("contract missing %q", required)
		}
	}
	if strings.Contains(contract, "agent_id") {
		t.Fatal("contract must use Role vocabulary, not agent_id")
	}
}

func TestOpenAPIOperationsMatchRegisteredRoutes(t *testing.T) {
	body, err := apiContract.ReadFile("openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	specOperations, err := parseOpenAPIOperations(body)
	if err != nil {
		t.Fatal(err)
	}

	env := newTestServer(t)
	if err := compareOperationSets(env.server.apiOperations, specOperations); err != nil {
		t.Fatal(err)
	}
}

func TestOperationSetDiffReportsBothDirections(t *testing.T) {
	routes := map[apiOperation]struct{}{{Method: "GET", Path: "/api/v1/route-only"}: {}}
	spec := map[apiOperation]struct{}{{Method: "POST", Path: "/api/v1/spec-only"}: {}}
	err := compareOperationSets(routes, spec)
	if err == nil {
		t.Fatal("mismatched operation sets must fail")
	}
	message := err.Error()
	for _, want := range []string{"registered route missing from OpenAPI: GET /api/v1/route-only", "OpenAPI operation missing from routes: POST /api/v1/spec-only"} {
		if !strings.Contains(message, want) {
			t.Fatalf("operation diff missing %q:\n%s", want, message)
		}
	}
}

// parseOpenAPIOperations intentionally handles only the stable, explicit shape
// of this contract. Path-level parameters are ignored; only the five methods
// registered by routeRegistrar become operations.
func parseOpenAPIOperations(body []byte) (map[apiOperation]struct{}, error) {
	const serverPrefix = "  - url:"
	operations := make(map[apiOperation]struct{})
	serverURL := ""
	currentPath := ""
	inPaths := false
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), " \t\r")
		if strings.HasPrefix(line, serverPrefix) && serverURL == "" {
			serverURL = strings.TrimSpace(strings.TrimPrefix(line, serverPrefix))
			serverURL = strings.Trim(serverURL, "'\"")
			continue
		}
		switch line {
		case "paths:":
			inPaths = true
			continue
		case "components:":
			inPaths = false
			continue
		}
		if !inPaths {
			continue
		}
		if strings.HasPrefix(line, "  /") && !strings.HasPrefix(line, "   ") && strings.HasSuffix(line, ":") {
			currentPath = strings.TrimSuffix(strings.TrimSpace(line), ":")
			continue
		}
		if !strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "     ") {
			continue
		}
		key, _, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok || !isOpenAPIMethod(strings.ToUpper(key)) {
			continue
		}
		if currentPath == "" {
			return nil, fmt.Errorf("OpenAPI method %q appears before a path", key)
		}
		op := apiOperation{Method: strings.ToUpper(key), Path: strings.TrimSuffix(serverURL, "/") + currentPath}
		if _, duplicate := operations[op]; duplicate {
			return nil, fmt.Errorf("duplicate OpenAPI operation %s %s", op.Method, op.Path)
		}
		operations[op] = struct{}{}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if serverURL == "" || !strings.HasPrefix(serverURL, "/") {
		return nil, fmt.Errorf("OpenAPI servers.url must be an absolute API path, got %q", serverURL)
	}
	return operations, nil
}

func compareOperationSets(routes, spec map[apiOperation]struct{}) error {
	missingSpec := operationDifference(routes, spec)
	missingRoutes := operationDifference(spec, routes)
	if len(missingSpec) == 0 && len(missingRoutes) == 0 {
		return nil
	}
	var lines []string
	for _, op := range missingSpec {
		lines = append(lines, fmt.Sprintf("registered route missing from OpenAPI: %s %s", op.Method, op.Path))
	}
	for _, op := range missingRoutes {
		lines = append(lines, fmt.Sprintf("OpenAPI operation missing from routes: %s %s", op.Method, op.Path))
	}
	return fmt.Errorf("route/OpenAPI operation mismatch:\n%s", strings.Join(lines, "\n"))
}

func operationDifference(left, right map[apiOperation]struct{}) []apiOperation {
	result := make([]apiOperation, 0)
	for op := range left {
		if _, ok := right[op]; !ok {
			result = append(result, op)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Path == result[j].Path {
			return result[i].Method < result[j].Method
		}
		return result[i].Path < result[j].Path
	})
	return result
}
