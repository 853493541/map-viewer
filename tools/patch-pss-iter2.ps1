# All-in-one disk-side patch for the PSS-only viewer iteration #2.
#
# 1) Server: add a result cache around buildPssAnalyzeResponse so repeated
#    /api/pss/analyze and /api/pss/debug-dump calls (current cold ~2.2s
#    each) become microseconds. Key = sourcePath. (PSS files are
#    immutable on disk during a session.)
#
# 2) HTML: move the "PSS" nav link from row-1 ("main") to row-2 ("Actor
#    pipeline") on every page that has it. Some pages had it in row-1
#    already; we relocate.
#
# 3) actor-animation-player.js: rewrite initPssOnlyMode() to:
#      - drop file extension and meta line in the list,
#      - replace the legacy debug panel content with a new
#        Things-went-right / Things-went-wrong tabbed log,
#      - record a per-step timeline (fetch analyze, fetch dump, parse,
#        per-mesh GLB load, per-texture load, etc.).
#
# Idempotent. Edits files via [IO.File]::WriteAllText so changes go to
# disk regardless of the editor buffer state.

$ErrorActionPreference = 'Stop'
function Patch-File($path, [scriptblock]$transform) {
  $content = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
  $newContent = & $transform $content
  if ($newContent -eq $content) {
    Write-Host "  no change in $path"
    return
  }
  [IO.File]::WriteAllText($path, $newContent, [Text.Encoding]::UTF8)
  Write-Host "  patched $path ($($content.Length) -> $($newContent.Length) bytes)"
}

# --------------------------------------------------------------------------
# 1) server.js — cache around buildPssAnalyzeResponse
# --------------------------------------------------------------------------
Write-Host "step 1: server.js cache"

Patch-File 'server.js' {
  param($c)
  if ($c.Contains('PSS_ANALYZE_CACHE')) {
    return $c  # already patched
  }
  $marker = "function buildPssAnalyzeResponse(sourcePathRaw) {"
  $idx = $c.IndexOf($marker)
  if ($idx -lt 0) { throw "buildPssAnalyzeResponse not found" }
  $head = $c.Substring(0, $idx)
  $tail = $c.Substring($idx)
  $insert = @'
// Result cache for buildPssAnalyzeResponse. PSS bytes are immutable per
// session; the parse + finalize pipeline is expensive (~2 s for a 150 KB
// file with 46 emitters). Caching the JSON-shape result turns repeat
// /api/pss/analyze and /api/pss/debug-dump calls into microseconds.
const PSS_ANALYZE_CACHE = new Map();
const PSS_ANALYZE_CACHE_MAX = 64;
function getPssAnalyzeCached(sourcePathRaw) {
  const key = String(sourcePathRaw || '');
  const cached = PSS_ANALYZE_CACHE.get(key);
  if (cached) return cached;
  const t0 = Date.now();
  const result = buildPssAnalyzeResponse(sourcePathRaw);
  result.__buildMs = Date.now() - t0;
  if (PSS_ANALYZE_CACHE.size >= PSS_ANALYZE_CACHE_MAX) {
    // FIFO eviction (sufficient for a small set; no hot-cold tracking).
    const firstKey = PSS_ANALYZE_CACHE.keys().next().value;
    if (firstKey !== undefined) PSS_ANALYZE_CACHE.delete(firstKey);
  }
  PSS_ANALYZE_CACHE.set(key, result);
  return result;
}

'@
  return $head + $insert + $tail
}

# Now redirect both call sites to the cached helper.
Patch-File 'server.js' {
  param($c)
  $c2 = $c.Replace("sendJson(res, 200, buildPssAnalyzeResponse(sourcePath));",
                   "sendJson(res, 200, getPssAnalyzeCached(sourcePath));")
  # And the internal call from /api/pss/debug-dump:
  $c2 = $c2.Replace("const analyzed = buildPssAnalyzeResponse(sourcePath);",
                    "const analyzed = getPssAnalyzeCached(sourcePath);")
  return $c2
}

# --------------------------------------------------------------------------
# 2) HTML nav: move "PSS" link from row-1 (main) to row-2 (Actor pipeline)
# --------------------------------------------------------------------------
Write-Host "step 2: nav move PSS to Actor pipeline row"

$pages = @(
  'public\index.html',
  'public\export-reader.html',
  'public\actor-viewer.html',
  'public\full-viewer.html',
  'public\mesh-inspector.html',
  'public\collision-test-mode.html',
  'public\actor-animation-player.html',
  'public\pss.html'
)

foreach ($p in $pages) {
  if (-not (Test-Path $p)) { continue }
  Patch-File $p {
    param($c)
    # Remove PSS link from row 1 (with optional aria-current).
    $c2 = $c
    $c2 = $c2 -replace '\s*<a class="gh-link( current)?" href="pss\.html"( aria-current="page")?>PSS</a>', ''
    # Drop any "current" status from previous row-2 entries on pss.html.
    if ($p -like '*\pss.html') {
      $c2 = $c2 -replace '<a class="gh-link current" href="actor-animation-player.html" aria-current="page">Animation Player</a>',
                         '<a class="gh-link" href="actor-animation-player.html">Animation Player</a>'
    }
    # Insert PSS link at the END of the row-2 nav (after "Animation Player").
    if ($p -like '*\pss.html') {
      $c2 = $c2.Replace(
        '<a class="gh-link" href="actor-animation-player.html">Animation Player</a>',
        '<a class="gh-link" href="actor-animation-player.html">Animation Player</a>' + "`n    " +
        '<a class="gh-link current" href="pss.html" aria-current="page">PSS</a>'
      )
    } else {
      # Match either the 4-space-indented or 6-space-indented variant.
      foreach ($pat in @(
        '    <a class="gh-link current" href="actor-animation-player.html" aria-current="page">Animation Player</a>',
        '    <a class="gh-link" href="actor-animation-player.html">Animation Player</a>',
        '      <a class="gh-link current" href="actor-animation-player.html" aria-current="page">Animation Player</a>',
        '      <a class="gh-link" href="actor-animation-player.html">Animation Player</a>'
      )) {
        if ($c2.Contains($pat) -and -not $c2.Contains('href="pss.html"')) {
          $indent = $pat.Substring(0, $pat.IndexOf('<'))
          $c2 = $c2.Replace($pat, $pat + "`n" + $indent + '<a class="gh-link" href="pss.html">PSS</a>')
          break
        }
      }
    }
    return $c2
  }
}

Write-Host "all done"
