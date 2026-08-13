package server

import (
	"strings"
	"testing"
)

func TestOpenAPIContractUsesCurrentVocabulary(t *testing.T) {
	body, err := apiContract.ReadFile("openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	contract := string(body)
	for _, required := range []string{"openapi: 3.1.0", "url: /api/v1", "/tasks:", "/roles:", "/runtimes:", "/workflow-proposals:", "Idempotency-Key", "If-Match", "role_id"} {
		if !strings.Contains(contract, required) {
			t.Fatalf("contract missing %q", required)
		}
	}
}
