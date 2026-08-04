// Package web 内嵌前端资源（模板 + 静态文件），保证单二进制分发。
package web

import "embed"

//go:embed templates static
var FS embed.FS
