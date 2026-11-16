//go:build !darwin

package main

// Sync commands for computers without ONE.GY Desktop (a server over SSH):
// thin front ends to the running engine's IPC methods
// (desktop/docs/engine-ipc.md), the same ones the desktop app calls. The
// rest of the IPC surface stays reachable with `onegy ipc call`.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/tifuck/one.gy/client/internal/config"
	"github.com/tifuck/one.gy/client/internal/ipc"
)

const syncUsage = `Folder sync (needs a running engine: onegy daemon, see client/README.md):
  onegy login [--user NAME] [--server URL] [--device NAME]
                                   Authorize this computer (password, 2FA code if on)
  onegy unlock                     Open the keys with the password (adding/changing syncs)
  onegy lock                       Drop the master key; syncing goes on in the sync folders
  onegy logout [--keep-device]     Sign out, pause syncs, wipe keys (files stay)
  onegy status                     Account, keys and every sync
  onegy sync list
  onegy sync add <local dir> [<one.gy folder>] [--type two_way|backup|mirror|archive|full]
                 [--initial merge|local_source|remote_source] [--name NAME] [--yes]
                                   Preview, then create (missing one.gy folders are created)
  onegy sync remove <id> [--release-backup]   Stop syncing (local files stay)
  onegy sync pause|resume [<id>]   One sync, or all
  onegy sync now <id>              Sync now
  onegy issues [<sync id>]         Open issues with their actions
  onegy issues resolve <issue id> <action> [<new name>]
  onegy issues resolve-all [<sync id>]
Common flags: --state-dir DIR, --socket PATH (default: the engine of this user)
Everything else (settings, versions, transfers, ignore rules): onegy ipc call <method> [json]
`

var stdin = bufio.NewReader(os.Stdin)

func readLine(prompt string) (string, error) {
	if prompt != "" {
		fmt.Fprint(os.Stderr, prompt)
	}
	line, err := stdin.ReadString('\n')
	if err != nil && (err != io.EOF || line == "") {
		return "", fmt.Errorf("no input")
	}
	return strings.TrimRight(line, "\r\n"), nil
}

type cliArgs struct {
	pos   []string
	flags map[string]string
}

// parseArgs takes --name value / --name=value (valued) and --name (bools)
// anywhere among the positional arguments.
func parseArgs(args []string, valued, bools []string) (cliArgs, error) {
	a := cliArgs{flags: map[string]string{}}
	valued = append(valued, "state-dir", "socket")
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "--") {
			a.pos = append(a.pos, arg)
			continue
		}
		name, val, has := strings.Cut(arg[2:], "=")
		switch {
		case slices.Contains(bools, name) && !has:
			a.flags[name] = "1"
		case slices.Contains(valued, name):
			if !has {
				if i+1 >= len(args) {
					return a, fmt.Errorf("--%s needs a value", name)
				}
				i++
				val = args[i]
			}
			a.flags[name] = val
		default:
			return a, fmt.Errorf("unknown flag --%s", name)
		}
	}
	return a, nil
}

type engineError struct {
	Message string `json:"message"`
	Data    struct {
		Code   string `json:"code"`
		Errors []struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"errors"`
	} `json:"data"`
}

func (e *engineError) Error() string {
	msg := e.Message
	for _, p := range e.Data.Errors {
		msg += "\n  - " + p.Message
	}
	return msg
}

func errCode(err error) string {
	var e *engineError
	if errors.As(err, &e) {
		return e.Data.Code
	}
	return ""
}

type engine struct{ socket string }

func openEngine(a cliArgs) (engine, error) {
	if s := a.flags["socket"]; s != "" {
		return engine{s}, nil
	}
	dir := a.flags["state-dir"]
	if dir == "" {
		d, err := config.DefaultStateDir()
		if err != nil {
			return engine{}, err
		}
		dir = d
	}
	return engine{config.RunningSocket(dir)}, nil
}

// call runs one IPC method and decodes its result into out (nil = ignore).
func (e engine) call(method string, params, out any) error {
	c, err := ipc.Dial(e.socket)
	if err != nil {
		return fmt.Errorf("the sync engine is not running (%v); start it with `onegy daemon --secrets-file` or its service", err)
	}
	defer c.Close()
	req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if _, err := c.Write(append(req, '\n')); err != nil {
		return err
	}
	r := bufio.NewReaderSize(c, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return fmt.Errorf("the sync engine closed the connection: %w", err)
		}
		var resp struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *engineError    `json:"error"`
		}
		if json.Unmarshal(line, &resp) != nil || resp.ID == nil {
			continue // an event
		}
		if resp.Error != nil {
			return resp.Error
		}
		if out == nil {
			return nil
		}
		return json.Unmarshal(resp.Result, out)
	}
}

type accountStatus struct {
	SignedIn     bool   `json:"signed_in"`
	Locked       bool   `json:"locked"`
	FullKeys     bool   `json:"full_keys"`
	AppLocked    bool   `json:"app_locked"`
	Server       string `json:"server"`
	Username     string `json:"username"`
	DeviceName   string `json:"device_name"`
	StorageUsed  int64  `json:"storage_used"`
	StorageLimit int64  `json:"storage_limit"`
}

type syncView struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	LocalPath  string `json:"local_path"`
	RemotePath string `json:"remote_path"`
	State      string `json:"state"`
	Detail     string `json:"detail"`
	Stats      struct {
		PendingUp    int    `json:"pending_up"`
		PendingDown  int    `json:"pending_down"`
		BytesLeft    int64  `json:"bytes_left"`
		Issues       int    `json:"issues"`
		LastSyncedAt string `json:"last_synced_at"`
	} `json:"stats"`
}

// runSyncCLI runs one of the sync commands; the exit code is returned.
func runSyncCLI(cmd string, args []string) int {
	if err := syncCommand(cmd, args); err != nil {
		fmt.Fprintln(os.Stderr, "onegy "+cmd+":", sanitizeTerminalText(err.Error()))
		return 1
	}
	return 0
}

func syncCommand(cmd string, args []string) error {
	var valued, bools []string
	switch cmd {
	case "login":
		valued = []string{"user", "server", "device"}
	case "logout":
		bools = []string{"keep-device"}
	case "sync":
		valued, bools = []string{"type", "initial", "name"}, []string{"yes", "release-backup"}
	}
	a, err := parseArgs(args, valued, bools)
	if err != nil {
		return err
	}
	e, err := openEngine(a)
	if err != nil {
		return err
	}
	switch cmd {
	case "login":
		return cmdLogin(e, a)
	case "unlock":
		pass, err := readSecret("Password: ")
		if err != nil {
			return err
		}
		var st accountStatus
		if err := e.call("account.unlock", map[string]any{"password": pass}, &st); err != nil {
			return err
		}
		fmt.Println("Unlocked.")
		return nil
	case "lock":
		if err := e.call("account.appLock", nil, nil); err != nil {
			return err
		}
		fmt.Println("Locked. Syncing goes on inside the sync folders; `onegy unlock` to add or change syncs.")
		return nil
	case "logout":
		if err := e.call("account.signOut", map[string]any{"revoke": a.flags["keep-device"] == ""}, nil); err != nil {
			return err
		}
		fmt.Println("Signed out. Syncs are paused; local files were kept.")
		return nil
	case "status":
		return cmdStatus(e)
	case "sync":
		return cmdSync(e, a)
	case "issues":
		return cmdIssues(e, a)
	}
	return fmt.Errorf("unknown command")
}

func cmdLogin(e engine, a cliArgs) error {
	server := a.flags["server"]
	if server == "" {
		server = baseURL()
	}
	device := a.flags["device"]
	if device == "" {
		device, _ = os.Hostname()
	}
	user := a.flags["user"]
	if user == "" {
		var err error
		if user, err = readLine("Username: "); err != nil {
			return err
		}
	}
	pass, err := readSecret("Password: ")
	if err != nil {
		return err
	}
	p := map[string]any{"server": server, "username": user, "password": pass, "device_name": device}
	var st accountStatus
	err = e.call("account.authorize", p, &st)
	if errCode(err) == "totp_required" {
		if p["totp_code"], err = readLine("Two-factor code: "); err != nil {
			return err
		}
		err = e.call("account.authorize", p, &st)
	}
	if err != nil {
		return err
	}
	fmt.Printf("Signed in as %s on %s; this computer is %q.\n", st.Username, st.Server, st.DeviceName)
	fmt.Println("Add a folder with `onegy sync add <dir> <one.gy folder>`.")
	return nil
}

func cmdStatus(e engine) error {
	var st accountStatus
	if err := e.call("account.status", nil, &st); err != nil {
		return err
	}
	if !st.SignedIn {
		fmt.Println("Not signed in. Run `onegy login`.")
		return nil
	}
	fmt.Printf("Signed in as %s on %s (device %q)\n", st.Username, st.Server, st.DeviceName)
	switch {
	case st.Locked:
		fmt.Println("Keys: closed, nothing syncs. Run `onegy unlock`.")
	case st.AppLocked:
		fmt.Println("Keys: locked. Syncing goes on inside the sync folders; `onegy unlock` to add or change syncs.")
	default:
		fmt.Println("Keys: unlocked")
	}
	if st.StorageLimit > 0 {
		fmt.Printf("Storage: %s of %s\n", formatSize(st.StorageUsed), formatSize(st.StorageLimit))
	}
	fmt.Println()
	return listSyncs(e)
}

func listSyncs(e engine) error {
	var syncs []syncView
	if err := e.call("syncs.list", nil, &syncs); err != nil {
		return err
	}
	if len(syncs) == 0 {
		fmt.Println("No syncs. Add one with `onegy sync add <dir> <one.gy folder>`.")
	}
	for _, s := range syncs {
		fmt.Printf("%s  %s  [%s]  %s\n    %s <-> one.gy%s\n", s.ID, sanitizeTerminalText(s.Name), s.Type, s.State,
			sanitizeTerminalText(s.LocalPath), sanitizeTerminalText(s.RemotePath))
		line := fmt.Sprintf("    %d up, %d down", s.Stats.PendingUp, s.Stats.PendingDown)
		if s.Stats.BytesLeft > 0 {
			line += ", " + formatSize(s.Stats.BytesLeft) + " left"
		}
		if s.Stats.Issues > 0 {
			line += fmt.Sprintf(", %d issue(s): `onegy issues %s`", s.Stats.Issues, s.ID)
		}
		if s.Stats.LastSyncedAt != "" {
			line += ", last synced " + s.Stats.LastSyncedAt
		}
		fmt.Println(line)
		if s.Detail != "" {
			fmt.Println("    " + sanitizeTerminalText(s.Detail))
		}
	}
	return nil
}

func cmdSync(e engine, a cliArgs) error {
	if len(a.pos) == 0 {
		return fmt.Errorf("missing subcommand\n%s", syncUsage)
	}
	sub, rest := a.pos[0], a.pos[1:]
	id := map[string]any{}
	if len(rest) > 0 {
		id["id"] = rest[0]
	}
	switch sub {
	case "list":
		return listSyncs(e)
	case "add":
		return syncAdd(e, a, rest)
	case "remove":
		if len(rest) != 1 {
			return fmt.Errorf("usage: onegy sync remove <id>")
		}
		id["release_backup"] = a.flags["release-backup"] != ""
		if err := e.call("syncs.remove", id, nil); err != nil {
			return err
		}
		fmt.Println("Sync removed; local files were kept.")
		return nil
	case "pause", "resume":
		if err := e.call("syncs."+sub, id, nil); err != nil {
			return err
		}
		fmt.Println(map[string]string{"pause": "Paused.", "resume": "Resumed."}[sub])
		return nil
	case "now":
		if len(rest) != 1 {
			return fmt.Errorf("usage: onegy sync now <id>")
		}
		return e.call("syncs.syncNow", id, nil)
	}
	return fmt.Errorf("unknown subcommand %q\n%s", sub, syncUsage)
}

func syncAdd(e engine, a cliArgs, rest []string) error {
	typ := a.flags["type"]
	if typ == "" {
		typ = "two_way"
	}
	if len(rest) < 1 || len(rest) > 2 {
		return fmt.Errorf("usage: onegy sync add <local dir> [<one.gy folder>] [--type ...]")
	}
	local, err := filepath.Abs(rest[0])
	if err != nil {
		return err
	}
	cfg := map[string]any{"local_path": local, "type": typ}
	if a.flags["name"] != "" {
		cfg["name"] = a.flags["name"]
	}
	switch {
	case typ == "full":
		cfg["remote_folder_id"] = nil
	case len(rest) == 2:
		id, err := e.remoteFolder(rest[1])
		if err != nil {
			return err
		}
		cfg["remote_folder_id"] = id
	case typ == "backup":
		var t struct {
			FolderID *int64 `json:"folder_id"`
			Path     string `json:"path"`
		}
		if err := e.call("syncs.backupTarget", map[string]any{"local_path": local, "create": true}, &t); err != nil {
			return err
		}
		fmt.Printf("Backing up to one.gy%s\n", t.Path)
		cfg["remote_folder_id"] = t.FolderID
	default:
		return fmt.Errorf("name the one.gy folder to sync with, e.g. onegy sync add %s /%s", rest[0], filepath.Base(local))
	}

	var v struct {
		OK       bool                       `json:"ok"`
		Errors   []struct{ Message string } `json:"errors"`
		Warnings []struct{ Message string } `json:"warnings"`
	}
	if err := e.call("syncs.validate", map[string]any{"local_path": local, "remote_folder_id": cfg["remote_folder_id"], "type": typ}, &v); err != nil {
		return err
	}
	for _, w := range v.Warnings {
		fmt.Println("Warning: " + w.Message)
	}
	if !v.OK {
		var msgs []string
		for _, p := range v.Errors {
			msgs = append(msgs, p.Message)
		}
		return fmt.Errorf("%s", strings.Join(msgs, "\n"))
	}

	params := map[string]any{"config": cfg, "initial": a.flags["initial"]}
	if a.flags["initial"] == "" {
		params["initial"] = "merge"
	}
	var pv struct {
		Uploads struct {
			Count int
			Bytes int64
		} `json:"uploads"`
		Downloads struct {
			Count int
			Bytes int64
		} `json:"downloads"`
		Conflicts int `json:"conflicts"`
		Deletions int `json:"deletions"`
	}
	if err := e.call("syncs.preview", params, &pv); err != nil {
		return err
	}
	fmt.Printf("First sync: %d upload(s) (%s), %d download(s) (%s), %d conflict(s), %d deletion(s)\n",
		pv.Uploads.Count, formatSize(pv.Uploads.Bytes), pv.Downloads.Count, formatSize(pv.Downloads.Bytes), pv.Conflicts, pv.Deletions)
	if a.flags["yes"] == "" {
		ans, err := readLine("Create this sync? [y/N] ")
		if err != nil || !strings.EqualFold(strings.TrimSpace(ans), "y") {
			return fmt.Errorf("cancelled")
		}
	}
	var s syncView
	if err := e.call("syncs.create", params, &s); err != nil {
		return err
	}
	fmt.Printf("Sync %s created: %s <-> one.gy%s\n", s.ID, sanitizeTerminalText(s.LocalPath), sanitizeTerminalText(s.RemotePath))
	return nil
}

// remoteFolder resolves "/A/B" to a folder id ("/" = drive root, nil),
// creating the missing folders end-to-end encrypted.
func (e engine) remoteFolder(path string) (*int64, error) {
	parts := strings.FieldsFunc(path, func(r rune) bool { return r == '/' })
	var id *int64
	for i, name := range parts {
		var ls struct {
			Folders []struct {
				ID   int64  `json:"id"`
				Name string `json:"name"`
			} `json:"folders"`
		}
		if err := e.call("remote.list", map[string]any{"folder_id": id}, &ls); err != nil {
			return nil, err
		}
		var next *int64
		for _, f := range ls.Folders {
			if f.Name == name {
				next = &f.ID
				break
			}
		}
		if next == nil {
			var f struct {
				ID int64 `json:"id"`
			}
			if err := e.call("remote.createFolder", map[string]any{"parent_id": id, "name": name, "e2ee": true}, &f); err != nil {
				return nil, err
			}
			fmt.Printf("Created the one.gy folder /%s\n", strings.Join(parts[:i+1], "/"))
			next = &f.ID
		}
		id = next
	}
	return id, nil
}

func cmdIssues(e engine, a cliArgs) error {
	if len(a.pos) > 0 && a.pos[0] == "resolve" {
		if len(a.pos) < 3 || len(a.pos) > 4 {
			return fmt.Errorf("usage: onegy issues resolve <issue id> <action> [<new name>]")
		}
		var id int64
		if _, err := fmt.Sscan(a.pos[1], &id); err != nil {
			return fmt.Errorf("issue id must be a number")
		}
		p := map[string]any{"id": id, "action": a.pos[2]}
		if len(a.pos) == 4 {
			p["name"] = a.pos[3]
		}
		return e.call("issues.resolve", p, nil)
	}
	if len(a.pos) > 0 && a.pos[0] == "resolve-all" {
		p := map[string]any{}
		if len(a.pos) > 1 {
			p["sync_id"] = a.pos[1]
		}
		var res struct {
			Resolved int `json:"resolved"`
		}
		if err := e.call("issues.resolveAll", p, &res); err != nil {
			return err
		}
		fmt.Printf("%d issue(s) resolved.\n", res.Resolved)
		return nil
	}
	p := map[string]any{}
	if len(a.pos) > 0 {
		p["sync_id"] = a.pos[0]
	}
	var issues []struct {
		ID      int64    `json:"id"`
		SyncID  string   `json:"sync_id"`
		Kind    string   `json:"kind"`
		Path    string   `json:"path"`
		Message string   `json:"message"`
		Actions []string `json:"actions"`
	}
	if err := e.call("issues.list", p, &issues); err != nil {
		return err
	}
	if len(issues) == 0 {
		fmt.Println("No open issues.")
	}
	for _, is := range issues {
		fmt.Printf("%d  %s  %s  %s\n    %s\n    actions: %s\n", is.ID, is.SyncID, is.Kind, sanitizeTerminalText(is.Path),
			sanitizeTerminalText(is.Message), strings.Join(is.Actions, ", "))
	}
	return nil
}
