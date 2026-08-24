// Package web embeds the built React application and the standalone login page.
package web

import "embed"

//go:embed templates/login.html static all:dist
var FS embed.FS
