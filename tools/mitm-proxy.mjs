#!/usr/bin/env node
// TLS-intercepting capture proxy. Use this only if the Frida path is blocked.
//
// Setup:
//   npm install mockttp
//   node tools\mitm-proxy.mjs --port 8888 --export-cert log\mitm-ca.pem
//
// Then in Windows:
//   1. Trust log\mitm-ca.pem in Local Machine -> Trusted Root Certification
//      Authorities (certmgr.msc).
//   2. Set system proxy (Settings -> Network & internet -> Proxy ->
//      Manual: 127.0.0.1:8888).
//   3. Restart the editor.
//
// Captured requests targeting *.xoyocdn.com or *editor-update* are logged to
// log\mitm-cdn.jsonl with method, full URL, status, and (when small)
// content-type + first bytes of body.

import { mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

let mockttp;
try {
  mockttp = await import('mockttp');
} catch {
  console.error('mockttp not installed. Install with:  npm install mockttp');
  process.exit(2);
}

function parseArgs(argv) {
  const cfg = { port: 8888, logPath: resolve('log/mitm-cdn.jsonl'), exportCert: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') cfg.port = Number(argv[++i]);
    else if (a === '--log') cfg.logPath = resolve(argv[++i]);
    else if (a === '--export-cert') cfg.exportCert = resolve(argv[++i]);
  }
  return cfg;
}

function fmtTs() { return new Date().toISOString().slice(11, 23); }

const TARGET_HOST_RE = /xoyocdn\.com|editor-update|jx3v5/i;

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(cfg.logPath), { recursive: true });

  const https = await mockttp.generateCACertificate({ commonName: 'jx3-mitm-ca' });
  if (cfg.exportCert) {
    mkdirSync(dirname(cfg.exportCert), { recursive: true });
    writeFileSync(cfg.exportCert, https.cert, 'utf8');
    console.error(`[${fmtTs()}] CA cert written to ${cfg.exportCert} — install in Local Machine\\Trusted Root.`);
  }

  const server = mockttp.getLocal({ https });
  await server.forAnyRequest().thenPassThrough({
    beforeRequest: (req) => {
      if (TARGET_HOST_RE.test(req.url)) {
        const line = `[${fmtTs()}] REQ  ${req.method}\t${req.url}`;
        console.log(line);
      }
      return {};
    },
    beforeResponse: (res) => {
      const url = res.tags?.url || '';
      if (TARGET_HOST_RE.test(url) || TARGET_HOST_RE.test(res.headers?.host || '')) {
        const line = `[${fmtTs()}] RESP ${res.statusCode}\tlen=${res.headers['content-length'] || '?'}`;
        console.log(line);
      }
      return {};
    },
  });

  // Subscribe to fully completed exchanges for the JSONL log.
  const logFd = openSync(cfg.logPath, 'a');
  await server.on('response', (event) => {
    if (!TARGET_HOST_RE.test(event.request.url)) return;
    const rec = {
      ts: Date.now(),
      method: event.request.method,
      url: event.request.url,
      status: event.statusCode,
      contentLength: event.headers?.['content-length'] || null,
      contentType: event.headers?.['content-type'] || null,
    };
    writeSync(logFd, JSON.stringify(rec) + '\n');
  });

  await server.start(cfg.port);
  console.error(`[${fmtTs()}] proxy listening on http://127.0.0.1:${cfg.port}`);
  console.error(`[${fmtTs()}] log: ${cfg.logPath}`);

  const stop = async () => {
    try { await server.stop(); } catch {}
    try { closeSync(logFd); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => { console.error(err); process.exit(1); });
