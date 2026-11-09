//go:build !devtls

package api

// DevTLS gates Options.InsecureTLS; release builds always verify certificates.
const DevTLS = false
