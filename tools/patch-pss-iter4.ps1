# Replace the iter3 PSS-only block (helpers + initPssOnlyMode) with the
# iter4 version that adds load-generation cancellation and the layout
# fix. Idempotent: if the file already contains the iter4-specific
# `__pssCurrentLoadGen` it does nothing.

$ErrorActionPreference = 'Stop'
$target = 'public\js\actor-animation-player.js'
$fragment = 'tools\pss-iter4-fragment.js'

$content = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)

if ($content -notmatch 'const __PSS_LOG') {
  throw "expected iter3 helpers (const __PSS_LOG) not found — file has unexpected shape"
}

$startMarker = 'const __PSS_LOG = {'
$startIdx = $content.IndexOf($startMarker)
if ($startIdx -lt 0) { throw "start marker not found" }

$endMarker = "`r`nasync function init() {"
$endIdx = $content.IndexOf($endMarker, $startIdx)
if ($endIdx -lt 0) {
  $endMarker = "`nasync function init() {"
  $endIdx = $content.IndexOf($endMarker, $startIdx)
}
if ($endIdx -lt 0) { throw "end marker not found" }

$head = $content.Substring(0, $startIdx)
$tail = $content.Substring($endIdx + 2)  # skip leading newline before async function init

$replacement = [IO.File]::ReadAllText($fragment, [Text.Encoding]::UTF8)
$lines = $replacement -split "`r?`n"
$skipUntil = 0
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^\s*//' -or $lines[$i] -match '^\s*$') { continue }
  $skipUntil = $i
  break
}
$body = ($lines[$skipUntil..($lines.Length - 1)] -join "`r`n")

$tailFromInit = $tail.Substring($tail.IndexOf('async function init() {'))
$new = $head + $body + "`r`n" + $tailFromInit

if (-not $new.Contains('__pssCurrentLoadGen')) { throw 'iter4 marker missing in result' }
if (-not $new.Contains('async function init() {')) { throw 'lost async function init()' }
if (-not $new.Contains('initPssOnlyMode')) { throw 'lost initPssOnlyMode' }

[IO.File]::WriteAllText($target, $new, [Text.Encoding]::UTF8)
Write-Host "patched $target ($($content.Length) -> $($new.Length) bytes)"
