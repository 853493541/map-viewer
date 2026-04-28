# Splices initPssOnlyMode + pss-only branch into actor-animation-player.js.
# Idempotent: if the marker already present, exits without changes.
$ErrorActionPreference = 'Stop'
$jsPath = 'public\js\actor-animation-player.js'
$content = [IO.File]::ReadAllText($jsPath, [Text.Encoding]::UTF8)

if ($content.Contains('initPssOnlyMode')) {
  Write-Host "already patched - nothing to do"
  exit 0
}

$fragment = [IO.File]::ReadAllText('public\js\pss-only-mode.js.fragment', [Text.Encoding]::UTF8)

# Anchor 1: the unhandledrejection block immediately precedes init().
$anchor1 = @'
  setAnimationPlayerStatus('error', msg);
  postDebugLogToServer();
});

async function init() {
  statusConnection.textContent = 'Loading...';
  statusConnection.className = 'status-item';
  setAnimationPlayerStatus('loading');

  // Init Three.js
  initThreeJs();
  // Do a single render so the viewport isn't blank
  renderer.render(scene, camera);

  try {
'@

if (-not $content.Contains($anchor1)) {
  Write-Error "anchor #1 not found - file shape changed"
}

$replacement1 = @"
  setAnimationPlayerStatus('error', msg);
  postDebugLogToServer();
});

$fragment

async function init() {
  statusConnection.textContent = 'Loading...';
  statusConnection.className = 'status-item';
  setAnimationPlayerStatus('loading');

  // Init Three.js
  initThreeJs();
  // Do a single render so the viewport isn't blank
  renderer.render(scene, camera);

  // PSS-only mode (pss.html): skip all actor / tani / serial / anim-table
  // loading and replace the sidebar with a flat .pss file picker. Same
  // addPssEffect() pipeline drives both pages, so renderer fixes propagate.
  if (document.body && document.body.dataset && document.body.dataset.pageMode === 'pss-only') {
    try {
      await initPssOnlyMode();
      setAnimationPlayerStatus('ready');
    } catch (err) {
      statusConnection.textContent = ``Error: `${err.message}``;
      statusConnection.className = 'status-item status-err';
      pssDebugState.errors.push({ msg: ``[pss-init] `${err.message}`` });
      setAnimationPlayerStatus('error', err.message);
    }
    return;
  }

  try {
"@

# PowerShell here-strings escape backticks differently - use a literal builder.
$replacement1 = $replacement1.Replace('``', '`')

$out = $content.Replace($anchor1, $replacement1)
if ($out -eq $content) {
  Write-Error "replacement produced no change"
}

[IO.File]::WriteAllText($jsPath, $out, [Text.Encoding]::UTF8)
Write-Host ("patched: {0} -> {1} bytes" -f $content.Length, $out.Length)
