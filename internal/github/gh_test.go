package github

import (
	"context"
	"testing"
)

func TestNewClient(t *testing.T) {
	c := NewClient()
	if c == nil {
		t.Fatal("nil client")
	}
	// 不执行真实 gh；仅验证类型可编译。
	_ = context.Background()
}
