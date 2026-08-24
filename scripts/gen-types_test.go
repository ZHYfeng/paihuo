package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestGenerateTypesMapsTagsNullabilityCollectionsOverridesAndNestedStructs(t *testing.T) {
	source := []byte(`package fixture
	type Fixture struct {
		ID int64 ` + "`json:\"id\"`" + `
		Name string ` + "`json:\"name,omitempty\"`" + `
		Pointer *int ` + "`json:\"pointer\"`" + `
		Values []string ` + "`json:\"values\"`" + `
		Labels map[string]string ` + "`json:\"labels\"`" + `
		Nested struct {
			Enabled bool ` + "`json:\"enabled\"`" + `
			Note *string ` + "`json:\"note\"`" + `
		} ` + "`json:\"nested\"`" + `
		Ratio float64 ` + "`json:\"ratio\"`" + `
		Mode string ` + "`json:\"mode\"`" + `
		Skipped string ` + "`json:\"-\"`" + `
	}
`)

	got, err := generateTypes(source, []string{"Fixture"}, map[string]string{"Fixture.Mode": `"fast" | "safe"`}, "// generated")
	if err != nil {
		t.Fatal(err)
	}
	want := `// generated

export interface Fixture {
  id: ID;
  name?: string;
  pointer: number | null;
  values: Array<string> | null;
  labels: Record<string, string> | null;
  nested: {
    enabled: boolean;
    note: string | null;
  };
  ratio: number;
  mode: "fast" | "safe";
}
`
	if !bytes.Equal(got, []byte(want)) {
		t.Fatalf("generated output mismatch\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}

	again, err := generateTypes(source, []string{"Fixture"}, map[string]string{"Fixture.Mode": `"fast" | "safe"`}, "// generated")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, again) {
		t.Fatal("generation must be deterministic")
	}
}

func TestGenerateTypesMapsNamedStructAndIDPointers(t *testing.T) {
	source := []byte(`package fixture
	type Child struct { Value string ` + "`json:\"value\"`" + ` }
	type Fixture struct {
		Child Child ` + "`json:\"child\"`" + `
		OwnerID *int64 ` + "`json:\"owner_id\"`" + `
	}
`)
	got, err := generateTypes(source, []string{"Child", "Fixture"}, nil, "// generated\nexport type ID = number;")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"child: Child;", "owner_id: ID | null;"} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("generated output missing %q:\n%s", want, got)
		}
	}
}

func TestStoreOverridesCoverDomainUnions(t *testing.T) {
	want := map[string]string{
		"Role.DelegationMaxPerm": "TaskPerm",
		"Task.Type":              "TaskType",
		"Task.Perm":              "TaskPerm",
		"Task.RunMode":           "TaskRunMode",
		"Task.DependencyMode":    "TaskDependencyMode",
		"Project.Status":         "ProjectStatus",
	}
	for field, typeName := range want {
		if storeOverrides[field] != typeName {
			t.Fatalf("override %s = %q, want %q", field, storeOverrides[field], typeName)
		}
	}
}

func TestGenerateTypesRejectsUnsupportedTypeWithFieldPath(t *testing.T) {
	source := []byte(`package fixture
	type Fixture struct { When complex128 ` + "`json:\"when\"`" + ` }
`)
	_, err := generateTypes(source, []string{"Fixture"}, nil, "// generated")
	if err == nil {
		t.Fatal("unsupported Go type must fail")
	}
	if !strings.Contains(err.Error(), "Fixture.When") || !strings.Contains(err.Error(), "complex128") {
		t.Fatalf("unsupported type error must name Struct.Field and type: %v", err)
	}
}
