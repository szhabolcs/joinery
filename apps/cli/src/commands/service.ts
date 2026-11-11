/**
 * `joinery service install|uninstall|status`: manage the background service
 * that keeps `joinery serve` running — a launchd LaunchAgent on macOS, a
 * systemd user unit on Linux.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  SERVICE_ENV,
  SERVICE_LABEL,
  SYSTEMD_UNIT,
  dataDirRoot,
  launchdTarget,
  runtimeLayout,
  serviceRestartCommand,
} from '@joinery/server/runtime';
import { UsageError } from '../args.ts';
import { printLine } from '../format.ts';
import { parseCommand, wantsHelp } from './shared.ts';
import type { Command } from './types.ts';

const isMac = process.platform === 'darwin';

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function systemdUnitPath(): string {
  const configHome = process.env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config');
  return join(configHome, 'systemd', 'user', SYSTEMD_UNIT);
}

/** The file that defines the service on this platform. */
export function serviceFile(): string {
  return isMac ? plistPath() : systemdUnitPath();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function renderPlist(binary: string, logFile: string, path: string): string {
  const e = escapeXml;
  // The port is not baked in: the server reads it from the data dir's `.port`.
  const extraEnv = ['JOINERY_DATA_DIR']
    .filter((k) => process.env[k])
    .map((k) => `\n    <key>${k}</key><string>${e(process.env[k] ?? '')}</string>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${e(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array><string>${e(binary)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${e(path)}</string>
    <key>JOINERY_HOME</key><string>${e(runtimeLayout().home)}</string>${extraEnv}
  </dict>
  <key>StandardOutPath</key><string>${e(logFile)}</string>
  <key>StandardErrorPath</key><string>${e(logFile)}</string>
</dict>
</plist>
`;
}

/** systemd unit values: quote, and escape what systemd would expand (`%` specifiers, `$` variables). */
function systemdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

function renderSystemdUnit(binary: string, logFile: string, path: string): string {
  const q = systemdQuote;
  const env = { PATH: path, JOINERY_HOME: runtimeLayout().home, [SERVICE_ENV]: '1' } as Record<string, string>;
  const dataDir = process.env['JOINERY_DATA_DIR'];
  if (dataDir) env['JOINERY_DATA_DIR'] = dataDir;
  const envLines = Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n');
  // The port is not baked in: the server reads it from the data dir's `.port`.
  return `[Unit]
Description=Joinery code review server

[Service]
ExecStart=${q(binary)} serve
Restart=always
RestartSec=2
${envLines}
StandardOutput=append:${logFile.replace(/%/g, '%%')}
StandardError=append:${logFile.replace(/%/g, '%%')}

[Install]
WantedBy=default.target
`;
}

async function exec(cmd: readonly string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([...cmd], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

const systemctl = (args: readonly string[]) => exec(['systemctl', '--user', ...args]);

async function launchctl(args: readonly string[]): Promise<{ code: number; out: string }> {
  return exec(['launchctl', ...args]);
}

async function isLoaded(): Promise<{ loaded: boolean; running: boolean }> {
  if (!isMac) {
    const enabled = await systemctl(['is-enabled', SYSTEMD_UNIT]);
    const active = await systemctl(['is-active', SYSTEMD_UNIT]);
    return { loaded: enabled.code === 0 || active.code === 0, running: active.code === 0 };
  }
  const res = await launchctl(['print', launchdTarget()]);
  return { loaded: res.code === 0, running: res.code === 0 && /state = running/.test(res.out) };
}

async function install(): Promise<void> {
  const layout = runtimeLayout();
  if (layout.mode !== 'installed') {
    throw new Error('this is a source checkout — the service runs the installed binary (see scripts/install.sh)');
  }
  const binary = join(layout.home, 'current', 'joinery');
  const logFile = join(dataDirRoot(), 'logs', 'server.log');
  await mkdir(join(dataDirRoot(), 'logs'), { recursive: true });
  const path = process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  if (!isMac) return installSystemd(binary, logFile, path);
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(plistPath(), renderPlist(binary, logFile, path));

  if ((await isLoaded()).loaded) {
    await launchctl(['bootout', launchdTarget()]);
    // bootout returns before teardown finishes; wait for the job to disappear.
    for (let i = 0; i < 50 && (await isLoaded()).loaded; i++) await sleep(100);
  }
  let res = await launchctl(['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath()]);
  for (let i = 0; i < 5 && res.code !== 0; i++) {
    await sleep(300);
    res = await launchctl(['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath()]);
  }
  if (res.code !== 0) throw new Error(`launchctl bootstrap failed: ${res.out.trim()}`);
  printLine(`service installed (${SERVICE_LABEL}); logs: ${logFile}`);
}

async function installSystemd(binary: string, logFile: string, path: string): Promise<void> {
  await mkdir(dirname(systemdUnitPath()), { recursive: true });
  await writeFile(systemdUnitPath(), renderSystemdUnit(binary, logFile, path));
  for (const args of [['daemon-reload'], ['enable', SYSTEMD_UNIT], ['restart', SYSTEMD_UNIT]]) {
    const res = await systemctl(args);
    if (res.code !== 0) throw new Error(`systemctl --user ${args.join(' ')} failed: ${res.out.trim()}`);
  }
  printLine(`service installed (${SYSTEMD_UNIT}); logs: ${logFile}`);
  // User units stop at logout unless the user lingers.
  const linger = await exec(['loginctl', 'show-user', String(process.getuid?.() ?? ''), '--property=Linger']);
  if (linger.code === 0 && !/Linger=yes/.test(linger.out)) {
    printLine('to keep it running while you are logged out: loginctl enable-linger');
  }
}

/** Kill and relaunch the running job so it picks up new permissions. False if not installed. */
export async function restartService(): Promise<boolean> {
  if (!(await isLoaded()).loaded) return false;
  const res = await exec(serviceRestartCommand());
  if (res.code !== 0) throw new Error(`could not restart the service: ${res.out.trim()}`);
  return true;
}

async function uninstall(): Promise<void> {
  if (isMac) {
    if ((await isLoaded()).loaded) await launchctl(['bootout', launchdTarget()]);
  } else if (existsSync(systemdUnitPath())) {
    await systemctl(['disable', '--now', SYSTEMD_UNIT]);
  }
  await rm(serviceFile(), { force: true });
  if (!isMac) await systemctl(['daemon-reload']);
  printLine('service uninstalled');
}

async function status(): Promise<void> {
  const { loaded, running } = await isLoaded();
  printLine(`${isMac ? 'plist  ' : 'unit   '}   ${existsSync(serviceFile()) ? serviceFile() : 'not installed'}`);
  printLine(`loaded    ${loaded ? 'yes' : 'no'}`);
  printLine(`running   ${running ? 'yes' : 'no'}`);
  printLine(`version   ${runtimeLayout().version}`);
}

export const service: Command = {
  path: 'service',
  summary: 'Manage the background server (launchd on macOS, systemd on Linux)',
  usage: 'joinery service <install|uninstall|status>',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(service.usage);
    if (process.platform === 'win32') {
      throw new Error('the background service is not available on Windows; run `joinery serve` or start-joinery.cmd instead');
    }
    const action = parsed.positionals[0];
    if (action === 'install') return install();
    if (action === 'uninstall') return uninstall();
    if (action === 'status') return status();
    throw new UsageError(`usage: ${service.usage}`);
  },
};
