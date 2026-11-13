//go:build devtls

package api

// DevTLS lets Options.InsecureTLS skip certificate checks, for a local DEV
// server with a self-signed certificate. Never used for release builds.
const DevTLS = true
