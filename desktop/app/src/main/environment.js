// Power and network facts for the engine (engine.environment): on_battery
// from powerMonitor, metered from NetworkManager (Linux) or the Windows
// connection cost. Sent on every engine connect, on power changes, and after
// a re-check at start, on resume and every 5 minutes. Never blocks the UI:
// the checks are async child processes with a timeout.
'use strict';

const fs = require('fs/promises');
const { execFile } = require('child_process');

const RECHECK_MS = 5 * 60 * 1000;
const EXEC_TIMEOUT_MS = 10000;
const WINDOWS_COST = '[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]'
  + '::GetInternetConnectionProfile().GetConnectionCost().NetworkCostType';

// stdout of a command, or '' when it is missing, fails or times out.
const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

// Interface of the default IPv4 route in /proc/net/route, or null.
function defaultRouteIface(table) {
  for (const line of String(table).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length > 2 && f[1] === '00000000') return f[0];
  }
  return null;
}

// "GENERAL.METERED:yes" or "yes (guessed)" -> true; no, unknown, nothing -> false.
const parseNmcliMetered = (out) => /^GENERAL\.METERED:\s*yes/im.test(String(out));

// NetworkCostType: Unrestricted / Unknown / no profile -> false; Fixed / Variable -> true.
const parseWindowsCost = (out) => ['fixed', 'variable'].includes(String(out).trim().toLowerCase());

async function isMetered(platform = process.platform) {
  if (platform === 'linux') {
    const iface = defaultRouteIface(await fs.readFile('/proc/net/route', 'utf8').catch(() => ''));
    if (!iface || !/^[\w.@:-]+$/.test(iface)) return false;
    return parseNmcliMetered(await run('nmcli', ['-t', '-f', 'GENERAL.METERED', 'dev', 'show', iface]));
  }
  if (platform === 'win32') return parseWindowsCost(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_COST]));
  return false;
}

// deps: { powerMonitor (Electron), engine (EngineSupervisor) }
function watchEnvironment({ powerMonitor, engine }) {
  let metered = false;
  let sent = null;
  const push = (force) => {
    const env = { on_battery: Boolean(powerMonitor.isOnBatteryPower()), metered };
    if (!force && sent && sent.on_battery === env.on_battery && sent.metered === env.metered) return;
    if (engine.state !== 'connected') return;
    sent = env;
    engine.call('engine.environment', env).catch((err) => {
      sent = null;
      console.error(`[APP] engine.environment failed: ${err.message}`);
    });
  };
  const recheck = async () => {
    metered = await isMetered();
    push(false);
  };
  powerMonitor.on('on-ac', () => push(false));
  powerMonitor.on('on-battery', () => push(false));
  powerMonitor.on('resume', recheck);
  engine.on('state', (s) => { if (s === 'connected') push(true); });
  setInterval(recheck, RECHECK_MS).unref();
  recheck();
}

module.exports = { watchEnvironment, isMetered, defaultRouteIface, parseNmcliMetered, parseWindowsCost };
