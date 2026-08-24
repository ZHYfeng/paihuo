package server

import (
	"errors"
	"net/http"

	"paihuo/internal/application"
)

func writeTaskLifecycleError(w http.ResponseWriter, err error) {
	var lifecycleErr *application.TaskLifecycleError
	if !errors.As(err, &lifecycleErr) {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	status := http.StatusInternalServerError
	switch lifecycleErr.Kind {
	case application.TaskErrorInvalid:
		status = http.StatusBadRequest
	case application.TaskErrorNotFound:
		status = http.StatusNotFound
	case application.TaskErrorConflict, application.TaskErrorRevisionConflict:
		status = http.StatusConflict
	case application.TaskErrorInternal:
		status = http.StatusInternalServerError
	}
	writeErr(w, status, lifecycleErr.Error())
}
