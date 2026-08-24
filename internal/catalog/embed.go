package catalog

import "embed"

// FS contains build-staged skill manifests, declared assets, and native runtimes.
//go:embed assets
var FS embed.FS
