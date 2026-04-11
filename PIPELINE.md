# Local Pipeline

Use this file as the quick startup reference.

## One simple command

From repository root:

```powershell
npm install
```

Then:

```powershell
npm run local
```

Server URL:
- http://localhost:3015

## Alternative one-word command (Windows)

```powershell
start-localhost
```

This runs start-localhost.cmd in the repo root.

## Other options

```powershell
npm run dev
npm start
node server.js
```

## Notes

- If npm is missing, install Node.js and reopen terminal.
- `npm run local` auto-generates `public/lib` from `node_modules` before server start.
- If port 3015 is busy, stop the old process first and rerun.
