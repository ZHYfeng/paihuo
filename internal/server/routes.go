package server

import (
	"fmt"
	"net/http"
	"strings"
)

type apiOperation struct {
	Method string
	Path   string
}

// routeRegistrar keeps the ServeMux registration and the API operation set as
// one fact. Browser pages, login and static assets bypass it and are therefore
// deliberately outside the OpenAPI contract.
type routeRegistrar struct {
	mux        *http.ServeMux
	operations map[apiOperation]struct{}
}

func newRouteRegistrar(mux *http.ServeMux) *routeRegistrar {
	return &routeRegistrar{mux: mux, operations: make(map[apiOperation]struct{})}
}

func (r *routeRegistrar) HandleFunc(pattern string, handler http.HandlerFunc) {
	method, path, ok := strings.Cut(pattern, " ")
	if !ok || !strings.HasPrefix(path, "/api/v1/") || !isOpenAPIMethod(method) {
		panic(fmt.Sprintf("invalid API route pattern %q", pattern))
	}
	op := apiOperation{Method: method, Path: path}
	if _, exists := r.operations[op]; exists {
		panic(fmt.Sprintf("duplicate API route %s %s", method, path))
	}
	r.operations[op] = struct{}{}
	r.mux.HandleFunc(pattern, handler)
}

func isOpenAPIMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}
