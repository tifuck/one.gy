module github.com/tifuck/one.gy/desktop/engine

go 1.22

require (
	github.com/Microsoft/go-winio v0.6.2
	github.com/fsnotify/fsnotify v1.8.0
	github.com/zalando/go-keyring v0.2.6
	golang.org/x/sys v0.30.0
	golang.org/x/text v0.21.0
	modernc.org/sqlite v1.36.1
	onegy v0.0.0
)

require (
	al.essio.dev/pkg/shellescape v1.5.1 // indirect
	github.com/danieljoos/wincred v1.2.2 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/godbus/dbus/v5 v5.1.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v0.1.9 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/exp v0.0.0-20230315142452-642cacee5cc0 // indirect
	modernc.org/libc v1.61.13 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.8.2 // indirect
)

replace onegy => ../../cli_E2EE_binary
