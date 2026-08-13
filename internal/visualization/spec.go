// Package visualization validates the only data-driven visual formats the web
// application may render. Role-produced HTML and JavaScript are never valid.
package visualization

import (
	"encoding/json"
	"fmt"
	"strings"
)

var allowedTypes = map[string]bool{"metric": true, "table": true, "timeline": true, "task_graph": true, "diff_summary": true, "series": true}

type Spec struct {
	Version int             `json:"version"`
	Type    string          `json:"type"`
	Title   string          `json:"title"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func Validate(raw []byte) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("invalid visualization JSON: %w", err)
	}
	if field := forbiddenField(value); field != "" {
		return fmt.Errorf("visualization field %q is forbidden", field)
	}
	var spec Spec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return err
	}
	if spec.Version != 1 {
		return fmt.Errorf("unsupported visualization version: %d", spec.Version)
	}
	if !allowedTypes[spec.Type] {
		return fmt.Errorf("unsupported visualization type: %s", spec.Type)
	}
	if spec.Title == "" {
		return fmt.Errorf("visualization title is required")
	}
	return nil
}

func forbiddenField(value any) string {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			normalized := strings.ToLower(strings.TrimSpace(key))
			switch normalized {
			case "html", "script", "javascript", "url":
				return key
			}
			switch normalized {
			case "onclick", "onload", "onerror", "onmouseover", "onfocus", "onblur", "onsubmit", "onchange", "oninput":
				return key
			}
			if field := forbiddenField(child); field != "" {
				return field
			}
		}
	case []any:
		for _, child := range typed {
			if field := forbiddenField(child); field != "" {
				return field
			}
		}
	}
	return ""
}
