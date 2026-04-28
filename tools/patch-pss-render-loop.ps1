$ErrorActionPreference = 'Stop'
$target = 'public\js\actor-animation-player.js'
$t = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)

if ($t.Contains('addPssEffect populates spriteEmitters/meshObjects/trackLines')) {
  Write-Host '(already patched)'
  exit 0
}

$nl = "`r`n"
$dot = [char]0x00B7
$needle =
  "setAnimationPlayerStatus('ready');" + $nl +
  '    pssLogStep(' + "'right'" + ', `scene ready ' + $dot + ' timeline ${(timelineTotalMs / 1000).toFixed(2)}s`, null);'

if (-not $t.Contains($needle)) { throw 'needle not found' }

$replacement =
  "setAnimationPlayerStatus('ready');" + $nl + $nl +
  '    // addPssEffect populates spriteEmitters/meshObjects/trackLines but' + $nl +
  '    // does NOT start the render loop or auto-fit the camera - those' + $nl +
  '    // are normally done by loadAllPssFromTani (which we bypass in' + $nl +
  '    // pss-only mode). Without these the canvas stays at the clear' + $nl +
  '    // color, which is exactly what the user reported.' + $nl +
  '    startRenderLoop();' + $nl +
  '    autoFitCameraToEffect();' + $nl +
  '    pssLogStep(' + "'right'" + ', `scene ready ' + $dot + ' timeline ${(timelineTotalMs / 1000).toFixed(2)}s`, {' + $nl +
  '      camDist: Math.round(orbitState.dist),' + $nl +
  '      camTarget: [Math.round(orbitState.targetX), Math.round(orbitState.targetY), Math.round(orbitState.targetZ)],' + $nl +
  '    });'

$t2 = $t.Replace($needle, $replacement)
if ($t2.Length -le $t.Length) { throw 'replace did not enlarge file' }
[IO.File]::WriteAllText($target, $t2, [Text.Encoding]::UTF8)
Write-Host ("size: " + $t.Length + ' -> ' + $t2.Length)
