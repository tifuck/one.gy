//go:build !darwin

package main

// `onegy daemon` is the sync engine: one per OS user, serving JSON-RPC on a
// private socket/pipe (desktop/docs/engine-ipc.md). ONE.GY Desktop spawns it
// and talks to it on its stdin and stdout (--ipc-stdio).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/config"
	"github.com/tifuck/one.gy/client/internal/ipc"
	"github.com/tifuck/one.gy/client/internal/logx"
	"github.com/tifuck/one.gy/client/internal/service"
)

func runDaemon(args []string) error {
	err := daemon(args)
	if err != nil {
		slog.Error("engine stopped", "err", err)
	}
	return err
}

func daemon(args []string) error {
	fs := flag.NewFlagSet("onegy daemon", flag.ExitOnError)
	stateDir := fs.String("state-dir", "", "state directory (default: per-OS app data dir)")
	socket := fs.String("socket", "", "IPC socket or pipe path (default: per-OS location)")
	logLevel := fs.String("log-level", "", "debug|info|warn|error (default: the log_level setting)")
	insecure := fs.Bool("insecure-tls", false, "skip TLS certificate checks (devtls builds only)")
	appStdio := fs.Bool("ipc-stdio", false, "serve the program that started the engine on stdin and stdout and stop when it is gone (ONE.GY Desktop); the socket then only answers ipc.hello, engine.info and engine.shutdown")
	secretsFile := fs.Bool("secrets-file", false, "keep the device secrets in <state dir>/secrets.json (0600) instead of the OS key store, for servers without one")
	version := fs.Bool("version", false, "print the version and exit")
	fs.Parse(args)
	if *version {
		fmt.Println(config.Version)
		return nil
	}

	if *stateDir == "" {
		d, err := config.DefaultStateDir()
		if err != nil {
			return err
		}
		*stateDir = d
	}
	if *socket == "" {
		*socket = config.DefaultSocket(*stateDir)
	}
	if err := config.EnsureStateDir(*stateDir); err != nil {
		return err
	}
	release, err := config.Lock(*stateDir)
	if err != nil {
		return err
	}
	defer release()

	logFile, err := logx.Setup(config.LogDir(*stateDir))
	if err != nil {
		return err
	}
	defer logFile.Close()
	if *logLevel != "" {
		lvl, err := logx.ParseLevel(*logLevel)
		if err != nil {
			return err
		}
		logx.Level.Set(lvl)
	}
	if *insecure {
		if !api.DevTLS {
			return fmt.Errorf("--insecure-tls only works in devtls builds")
		}
		slog.Warn("TLS certificate verification is disabled (--insecure-tls)")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	opts := service.Options{StateDir: *stateDir, LogLevel: *logLevel,
		API: api.Options{Version: config.Version, InsecureTLS: *insecure}}
	if *secretsFile {
		opts.SecretsFile = filepath.Join(*stateDir, "secrets.json")
		slog.Info("device secrets are kept in a file (--secrets-file)")
	}
	svc, err := service.New(ctx, opts)
	if err != nil {
		return err
	}
	randomKey := func() string {
		kb := make([]byte, 32)
		rand.Read(kb)
		return hex.EncodeToString(kb)
	}
	if *appStdio {
		// The app can go away at any time: a write to it must fail, not end the engine.
		signal.Ignore(syscall.SIGPIPE)
		svc.SetAppConn(ipc.Stdio(os.Stdin, os.Stdout))
		svc.SetIPCSecret(randomKey()) // told to no one: the socket stays untrusted
	}
	helloKey := randomKey()
	svc.SetIPCHelloKey(helloKey)
	ln, err := ipc.Listen(*socket)
	if err != nil {
		return err
	}
	if err := config.WriteEngineInfo(*stateDir, *socket, helloKey); err != nil {
		ln.Close()
		return err
	}
	defer config.RemoveEngineInfo(*stateDir)
	slog.Info("engine started", "version", config.Version, "pid", os.Getpid())
	err = svc.Serve(ctx, ln)
	slog.Info("engine stopped")
	return err
}
