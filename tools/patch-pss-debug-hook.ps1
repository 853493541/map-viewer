$ErrorActionPreference = 'Stop'
$target = 'public\js\actor-animation-player.js'
$t = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)

# 1) Add preserveDrawingBuffer flag to renderer.
$old1 = "  renderer = new THREE.WebGLRenderer({`r`n    canvas: viewportCanvas,`r`n    antialias: true,`r`n    alpha: true,`r`n  });"
$new1 = "  renderer = new THREE.WebGLRenderer({`r`n    canvas: viewportCanvas,`r`n    antialias: true,`r`n    alpha: true,`r`n    preserveDrawingBuffer: true, // visual test snapshot support`r`n  });"
if (-not $t.Contains($old1)) { throw 'renderer-block marker not found' }
if ($t.Contains('preserveDrawingBuffer')) { Write-Host '(preserveDrawingBuffer already present, skipping renderer edit)' }
else { $t = $t.Replace($old1, $new1) }

# 2) Add window.__pssDebug snapshot hook at end of initThreeJs.
$old2 = "  // Resize`r`n  const ro = new ResizeObserver(() => resizeRenderer());`r`n  ro.observe(viewportPanel);`r`n  resizeRenderer();`r`n}"
$debugHook = @"
  // Resize
  const ro = new ResizeObserver(() => resizeRenderer());
  ro.observe(viewportPanel);
  resizeRenderer();

  // Test/debug introspection hook — module scope is invisible to
  // page.evaluate, so we expose a snapshot function. Cheap, no perf
  // cost unless called.
  window.__pssDebug = () => {
    const vp = document.getElementById('viewport-panel');
    const ra = document.getElementById('right-area');
    const lp = document.getElementById('pss-log-panel');
    const rectOf = (el) => el ? el.getBoundingClientRect().toJSON() : null;
    return {
      canvas: {
        w: viewportCanvas.width,
        h: viewportCanvas.height,
        cw: viewportCanvas.clientWidth,
        ch: viewportCanvas.clientHeight,
      },
      rendererSize: renderer ? renderer.getSize(new THREE.Vector2()).toArray() : null,
      isRendering: typeof isRendering !== 'undefined' ? isRendering : null,
      scene: scene ? {
        children: scene.children.length,
        types: scene.children.map((c) => c.type + (c.name ? ':' + c.name : '')).slice(0, 30),
      } : null,
      counts: {
        sprite: (typeof spriteEmitters !== 'undefined' && spriteEmitters) ? spriteEmitters.length : -1,
        mesh: (typeof meshObjects !== 'undefined' && meshObjects) ? meshObjects.length : -1,
        track: (typeof trackLines !== 'undefined' && trackLines) ? trackLines.length : -1,
      },
      camera: camera ? {
        pos: [camera.position.x, camera.position.y, camera.position.z],
        aspect: camera.aspect,
        fov: camera.fov,
      } : null,
      orbit: typeof orbitState !== 'undefined' ? { ...orbitState } : null,
      layout: {
        viewportPanel: rectOf(vp),
        rightArea: rectOf(ra),
        logPanel: rectOf(lp),
        rightAreaInlineRight: ra ? ra.style.right : null,
      },
    };
  };
}
"@
$debugHook = $debugHook -replace "`r?`n", "`r`n"
if (-not $t.Contains($old2)) {
  if ($t.Contains('window.__pssDebug')) { Write-Host '(__pssDebug already present)' }
  else { throw 'initThreeJs end marker not found' }
} else {
  $t = $t.Replace($old2, $debugHook)
}

[IO.File]::WriteAllText($target, $t, [Text.Encoding]::UTF8)
Write-Host "patched. file size = $($t.Length)"
Write-Host ("preserveDrawingBuffer=" + $t.Contains('preserveDrawingBuffer'))
Write-Host ("__pssDebug=" + $t.Contains('window.__pssDebug'))
