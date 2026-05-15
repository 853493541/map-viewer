#!/usr/bin/env node
// Attach Frida to the Resource Browser process and run tools/frida-cdn-agent.js
// inside it. Captures every URL the browser builds (WinHttp/WinINet/libcurl) plus
// any sprintf-formed PakV5 stream URL.
//
// Setup:
//   npm install frida           (or: npm install --save-dev frida)
//
// Usage:
//   node tools\frida-attach.mjs --process qrmbtrayservicex64.exe
//   node tools\frida-attach.mjs --processes qrmbtrayservicex64.exe,qseasuneditorx64.exe
//   node tools\frida-attach.mjs --pid 12345
//   node tools\frida-attach.mjs --spawn "C:\\path\\to\\qseasuneditor.exe"
//
// Notes:
//   - Run PowerShell **as Administrator** so Frida can attach.
//   - All captured URLs are appended to log\\frida-cdn.jsonl AND printed.

import { readFileSync, mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createServer } from 'node:http';

let frida;
try {
  frida = (await import('frida')).default || (await import('frida'));
} catch (err) {
  console.error('frida npm package is missing. Install with:  npm install frida');
  process.exit(2);
}

function parseArgs(argv) {
  const cfg = { processNames: [], pid: null, spawn: null, agent: resolve('tools/frida-cdn-agent.js'), logPath: resolve('log/frida-cdn.jsonl') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--process') cfg.processNames = [argv[++i]];
    else if (a === '--processes') cfg.processNames = String(argv[++i] || '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (a === '--pid') cfg.pid = Number(argv[++i]);
    else if (a === '--spawn') cfg.spawn = argv[++i];
    else if (a === '--agent') cfg.agent = resolve(argv[++i]);
    else if (a === '--log') cfg.logPath = resolve(argv[++i]);
  }
  if (!cfg.processNames.length && !cfg.pid && !cfg.spawn) {
    cfg.processNames = ['qrmbtrayservicex64.exe', 'qseasuneditorx64.exe'];
  }
  return cfg;
}

function fmtTs() { return new Date().toISOString().slice(11, 23); }
function sanitizeFileName(value) {
  const safe = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'item';
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(cfg.logPath), { recursive: true });
  const logFd = openSync(cfg.logPath, 'a');
  const logLine = (obj) => writeSync(logFd, JSON.stringify({ ts: Date.now(), ...obj }) + '\n');

  const device = await frida.getLocalDevice();

  let pid = cfg.pid;
  let spawned = false;
  let targetName = cfg.processNames[0] || (cfg.pid ? `pid-${cfg.pid}` : 'process');
  if (cfg.spawn) {
    pid = await device.spawn([cfg.spawn]);
    spawned = true;
    targetName = cfg.spawn;
    console.error(`[${fmtTs()}] spawned pid=${pid}`);
  } else if (!pid) {
    const procs = await device.enumerateProcesses();
    let target = null;
    for (const name of cfg.processNames) {
      target = procs.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (target) break;
    }
    if (!target) {
      console.error(`process not found: ${cfg.processNames.join(', ')}`);
      console.error('candidates:');
      for (const p of procs) {
        if (/editor|jx3|seasun|qseasun|rmb|browser/i.test(p.name)) console.error(`  ${p.pid}\t${p.name}`);
      }
      process.exit(3);
    }
    pid = target.pid;
    targetName = target.name;
    console.error(`[${fmtTs()}] attaching to ${target.name} pid=${pid}`);
  } else {
    console.error(`[${fmtTs()}] attaching to pid=${pid}`);
  }

  const dumpDir = resolve(join(dirname(cfg.logPath), 'bundle-dumps', `${sanitizeFileName(targetName)}-${pid}`));
  mkdirSync(dumpDir, { recursive: true });

  const session = await device.attach(pid);
  const source = readFileSync(cfg.agent, 'utf8');
  const script = await session.createScript(source);
  const pendingCmds = new Map(); // id -> {resolve, reject}
  let nextCmdId = 1;
  script.message.connect((msg, data) => {
    if (msg.type === 'send') {
      const p = msg.payload || {};
      if (p.type === 'bundle-dump' && data) {
        try {
          const binary = Buffer.from(data);
          const fileName = `${Date.now()}-${sanitizeFileName(p.name || 'bundle')}-r${Number(p.readIndex) || 0}-${binary.length}.bin`;
          const filePath = resolve(join(dumpDir, fileName));
          writeFileSync(filePath, binary);
          const record = { ...p, filePath, processName: targetName, pid };
          const line = `[${fmtTs()}] bundle-dump ${JSON.stringify({ ...record, type: undefined })}`;
          console.log(line);
          logLine(record);
        } catch (e) {
          console.error(`[${fmtTs()}] bundle-dump write failed: ${String(e)}`);
        }
        return;
      }
      if (p.type === 'cmdResult' && p.id != null && pendingCmds.has(p.id)) {
        pendingCmds.get(p.id).resolve(p.result);
        pendingCmds.delete(p.id);
      }
      const suppressHealthLog = p.type === 'cmdResult' && p.cmd === 'getApiState';
      if (!suppressHealthLog) {
        const line = `[${fmtTs()}] ${p.type || '?'} ${JSON.stringify({ ...p, type: undefined })}`;
        console.log(line);
        logLine(p);
      }
    } else if (msg.type === 'error') {
      console.error(`[${fmtTs()}] AGENT ERROR: ${msg.description}\n${msg.stack || ''}`);
    }
  });
  await script.load();
  if (spawned) await device.resume(pid);

  function sendCmd(payload) {
    const id = nextCmdId++;
    return new Promise((res, rej) => {
      pendingCmds.set(id, { resolve: res, reject: rej });
      script.post({ type: 'cmd', payload: { ...payload, id } });
      setTimeout(() => {
        if (pendingCmds.has(id)) { pendingCmds.delete(id); rej(new Error('timeout')); }
      }, 60_000);
    });
  }

  // Local HTTP control server so other tools can drive downloads.
  const ctlPort = Number(process.env.FRIDA_CTL_PORT || 39314);
  const httpSrv = createServer(async (req, rsp) => {
    if (req.method !== 'POST') { rsp.writeHead(405); rsp.end(); return; }
    let body = ''; req.on('data', (c) => body += c);
    req.on('end', async () => {
      try {
        const cmd = JSON.parse(body || '{}');
        const result = await sendCmd(cmd);
        rsp.writeHead(200, { 'content-type': 'application/json' });
        rsp.end(JSON.stringify(result));
      } catch (e) {
        rsp.writeHead(500, { 'content-type': 'application/json' });
        rsp.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
  });
  httpSrv.listen(ctlPort, '127.0.0.1', () => {
    console.error(`[${fmtTs()}] agent loaded, control on http://127.0.0.1:${ctlPort}/. Log: ${cfg.logPath}`);
  });

  const stop = async () => {
    try { await script.unload(); } catch {}
    try { await session.detach(); } catch {}
    try { closeSync(logFd); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {}); // keep alive
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
