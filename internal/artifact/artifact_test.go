package artifact

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestLocalStoreIsContentAddressedAndRejectsPaths(t *testing.T) {
	store, err := NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.Put(context.Background(), strings.NewReader("result"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Put(context.Background(), strings.NewReader("result"))
	if err != nil {
		t.Fatal(err)
	}
	if first.Hash != second.Hash || first.Locator != second.Locator || first.Size != 6 {
		t.Fatalf("not content addressed: %#v %#v", first, second)
	}
	reader, err := store.Open(context.Background(), first.Locator)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(reader)
	_ = reader.Close()
	if string(body) != "result" {
		t.Fatalf("body=%q", body)
	}
	if _, err := store.Open(context.Background(), "../../etc/passwd"); err == nil {
		t.Fatal("path escape accepted")
	}
}
