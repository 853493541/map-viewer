import { execFileSync } from 'node:child_process';
import process from 'node:process';

const port = Number(process.env.PORT || 3015);
const waitMs = Number(process.env.JX3_PORT_RECLAIM_WAIT_MS || 8000);
const args = new Set(process.argv.slice(2));

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', windowsHide: true });
}

function psLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function isWindowsAdmin() {
  if (process.platform !== 'win32') return true;
  try {
    const output = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "$id=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=New-Object Security.Principal.WindowsPrincipal($id); $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"]);
    return /^true$/i.test(output.trim());
  } catch (_) {
    return false;
  }
}

function launchElevated() {
  const nodeExe = process.execPath;
  const ps = `$arguments=@('tools/start-local.mjs','--elevated-child'); Start-Process -FilePath ${psLiteral(nodeExe)} -ArgumentList $arguments -WorkingDirectory ${psLiteral(process.cwd())} -Verb RunAs`;
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
}

function shouldElevate() {
  if (process.platform !== 'win32') return false;
  if (args.has('--elevated-child') || args.has('--no-elevate')) return false;
  if (process.env.JX3_LOCAL_ELEVATE === '0' || process.env.CI) return false;
  if (!args.has('--elevate') && process.env.JX3_LOCAL_ELEVATE !== '1') return false;
  return !isWindowsAdmin();
}

function addressUsesPort(address, targetPort) {
  return String(address || '').trim().endsWith(`:${targetPort}`);
}

function findWindowsListeners(targetPort) {
  const output = run('netstat.exe', ['-ano', '-p', 'tcp']);
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim();
    if (!/\bLISTENING\b/i.test(text)) continue;
    const parts = text.split(/\s+/);
    if (parts.length < 5 || !addressUsesPort(parts[1], targetPort)) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids].sort((left, right) => left - right);
}

function findListeners(targetPort) {
  if (process.platform === 'win32') return findWindowsListeners(targetPort);
  return [];
}

function killWindowsProcess(pid) {
  run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
}

function killListener(pid) {
  if (process.platform === 'win32') {
    killWindowsProcess(pid);
    return;
  }
  process.kill(pid, 'SIGTERM');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPortFree(targetPort) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const listeners = findListeners(targetPort);
    if (!listeners.length) return true;
    await sleep(200);
  }
  return false;
}

async function reclaimPort(targetPort) {
  const listeners = findListeners(targetPort);
  if (!listeners.length) {
    console.log(`[start-local] port ${targetPort} is free`);
    return;
  }
  console.log(`[start-local] port ${targetPort} is in use by pid(s): ${listeners.join(', ')}`);
  for (const pid of listeners) {
    try {
      console.log(`[start-local] killing pid ${pid}`);
      killListener(pid);
    } catch (error) {
      const detail = error?.stderr || error?.stdout || error?.message || String(error);
      throw new Error(`Failed to kill pid ${pid} on port ${targetPort}: ${String(detail).trim()}`);
    }
  }
  if (!(await waitForPortFree(targetPort))) {
    throw new Error(`Port ${targetPort} is still in use after killing pid(s): ${listeners.join(', ')}`);
  }
  console.log(`[start-local] port ${targetPort} is clear`);
}

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid PORT value: ${process.env.PORT || ''}`);
}

if (shouldElevate()) {
  console.log('[start-local] server is not elevated; requesting Administrator terminal because --elevate or JX3_LOCAL_ELEVATE=1 was set');
  launchElevated();
  console.log('[start-local] elevated server launch requested; close this non-elevated run if a new admin window opened');
  process.exit(0);
}

await reclaimPort(port);
process.env.PORT = String(port);
process.env.JX3_SERVER_PERSIST = process.env.JX3_SERVER_PERSIST || '1';
await import('../server.js');