# Splice tools/pss-iter3-fragment.js into actor-animation-player.js,
# replacing the existing async function initPssOnlyMode() definition.
# Idempotent — running twice produces the same result.

$ErrorActionPreference = 'Stop'
$target = 'public\js\actor-animation-player.js'
$fragment = 'tools\pss-iter3-fragment.js'

$content = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)
$replacement = [IO.File]::ReadAllText($fragment, [Text.Encoding]::UTF8)

$startMarker = 'async function initPssOnlyMode() {'
$startIdx = $content.IndexOf($startMarker)
if ($startIdx -lt 0) { throw "start marker not found" }

# Walk forward to find the matching closing brace for this top-level async
# function. We can rely on the next line `async function init() {` as the
# end sentinel — that's the function immediately after initPssOnlyMode in
# the file.
$endMarker = "`r`nasync function init() {"
$endIdx = $content.IndexOf($endMarker, $startIdx)
if ($endIdx -lt 0) {
  $endMarker = "`nasync function init() {"
  $endIdx = $content.IndexOf($endMarker, $startIdx)
}
if ($endIdx -lt 0) { throw "end marker (async function init) not found" }

# We want to replace [startIdx .. endIdx) — i.e. everything from the start
# of `async function initPssOnlyMode` up to (not including) the newline
# before `async function init`. The replacement fragment ends with a
# trailing newline so the output stays clean.
$head = $content.Substring(0, $startIdx)
$tail = $content.Substring($endIdx + 2)  # skip the leading CRLF/LF before `async function init`

# Drop the leading comment block in the fragment (lines that start with
# `//` and are part of the file header) so we don't bloat the JS file with
# meta-explanation. We keep the marker comment for the splice itself.
# Find the first non-comment, non-blank line in the fragment and use that
# as the start.
$lines = $replacement -split "`r?`n"
$skipUntil = 0
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^\s*//' -or $lines[$i] -match '^\s*$') { continue }
  $skipUntil = $i
  break
}
$bodyLines = $lines[$skipUntil..($lines.Length - 1)]
$body = ($bodyLines -join "`r`n")

$new = $head + $body + "`r`n" + $tail.Substring($tail.IndexOf('async function init() {'))

# Sanity guard
if (-not $new.Contains('initPssOnlyMode')) { throw 'splice produced output without initPssOnlyMode' }
if (-not $new.Contains('pssLogInstallPanel')) { throw 'splice missing pssLogInstallPanel' }
if (-not $new.Contains('async function init() {')) { throw 'splice lost async function init()' }

[IO.File]::WriteAllText($target, $new, [Text.Encoding]::UTF8)
Write-Host "patched $target ($($content.Length) -> $($new.Length) bytes)"
