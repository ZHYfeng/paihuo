package application

import "fmt"

type TaskErrorKind string

const (
	TaskErrorInvalid          TaskErrorKind = "invalid"
	TaskErrorNotFound         TaskErrorKind = "not_found"
	TaskErrorConflict         TaskErrorKind = "conflict"
	TaskErrorRevisionConflict TaskErrorKind = "revision_conflict"
	TaskErrorInternal         TaskErrorKind = "internal"
)

// TaskLifecycleError classifies use-case failures without importing net/http.
// Message is the stable product-facing text; Cause remains available to tests
// and non-HTTP callers through errors.Is/errors.As.
type TaskLifecycleError struct {
	Kind    TaskErrorKind
	Message string
	Cause   error
}

func (e *TaskLifecycleError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Cause != nil {
		return e.Cause.Error()
	}
	return string(e.Kind)
}

func (e *TaskLifecycleError) Unwrap() error { return e.Cause }

func taskError(kind TaskErrorKind, message string, cause error) error {
	if message == "" && cause == nil {
		cause = fmt.Errorf("task lifecycle error: %s", kind)
	}
	return &TaskLifecycleError{Kind: kind, Message: message, Cause: cause}
}
