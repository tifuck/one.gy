//go:build !darwin

package main

// `onegy daemon` is the sync engine: one per OS user, serving JSON-RPC on a
// private socket/pipe (desktop/docs/engine-ipc.md). ONE.GY Desktop spawns it.

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
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
	secretStdin := fs.Bool("ipc-secret-stdin", false, "read the IPC secret (first line of stdin); clients must present it with ipc.hello")
	secretsFile := fs.Bool("secrets-file", false, "keep the device secrets in <state dir>/secrets.json (0600) instead of the OS key store, for servers without one")
	version := fs.Bool("version", false, "print the version and exit")
	fs.Parse(args)
	if *version {
		fmt.Println(config.Version)
		return nil
	}

	var secret string
	if *secretStdin {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		secret = strings.TrimSpace(line)
		if len(secret) < 32 {
			return fmt.Errorf("--ipc-secret-stdin: no secret on stdin (%v)", err)
		}
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
	svc.SetIPCSecret(secret)
	ln, err := ipc.Listen(*socket)
	if err != nil {
		return err
	}
	if err := config.WriteEngineInfo(*stateDir, *socket); err != nil {
		ln.Close()
		return err
	}
	defer config.RemoveEngineInfo(*stateDir)
	slog.Info("engine started", "version", config.Version, "pid", os.Getpid())
	err = svc.Serve(ctx, ln)
	slog.Info("engine stopped")
	return err
}
