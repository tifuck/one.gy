//go:build !linux && !windows

package service

func detectFS(string) fsInfo { return fsInfo{Kind: "unknown", CaseSensitive: true} }
