package main

import "testing"

func TestIsLoopbackAddr(t *testing.T) {
	tests := []struct {
		addr string
		want bool
	}{
		{"127.0.0.1:8080", true},
		{"localhost:8080", true},
		{"[::1]:8080", true},
		{":8080", false},
		{"0.0.0.0:8080", false},
		{"[::]:8080", false},
		{"192.0.2.1:8080", false},
		{"invalid", false},
	}
	for _, tt := range tests {
		t.Run(tt.addr, func(t *testing.T) {
			if got := isLoopbackAddr(tt.addr); got != tt.want {
				t.Errorf("isLoopbackAddr(%q) = %v，期望 %v", tt.addr, got, tt.want)
			}
		})
	}
}

func TestValidateListenSecurity(t *testing.T) {
	tests := []struct {
		name  string
		addr  string
		token string
		want  bool
	}{
		{"local without token", "127.0.0.1:8080", "", false},
		{"public without token", "0.0.0.0:8080", "", true},
		{"unspecified without token", ":8080", "", true},
		{"public with token", "0.0.0.0:8080", "secret", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := validateListenSecurity(tt.addr, tt.token) != nil; got != tt.want {
				t.Errorf("validateListenSecurity(%q, token set=%v) error=%v，期望错误=%v", tt.addr, tt.token != "", got, tt.want)
			}
		})
	}
}
