package session

import (
	"encoding/json"
	"time"
)

func timeAfter(sec int) <-chan time.Time { return time.After(time.Duration(sec) * time.Second) }

func timeSleep(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) }

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
