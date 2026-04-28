$ErrorActionPreference = 'Stop'
$path = Join-Path (Split-Path -Parent $PSScriptRoot) 'public\js\actor-animation-player.js'
$txt = [IO.File]::ReadAllText($path)
if ($txt.Contains('__pssEmitterInventory')) { Write-Host 'already installed'; exit 0 }

$marker = "  // Drive the timeline for time-evolution tests. Sets timelineMs and"
if (-not $txt.Contains($marker)) { throw "marker not found" }

$inject = @'
  // Detailed per-emitter inventory for the "white walls" diagnostic. Returns
  // the actual rendering parameters that ended up on the GPU — texture src,
  // material color/opacity/blending, geometry vert count, world-space size,
  // particle counts — so a test can print a flat table and the bad emitters
  // are immediately obvious. NOT cheap to run every frame; intended for
  // single-shot diagnostics.
  window.__pssEmitterInventory = () => {
    const v3 = (o) => o ? [+o.x.toFixed(3), +o.y.toFixed(3), +o.z.toFixed(3)] : null;
    const colArr = (c) => c ? [+c.r.toFixed(3), +c.g.toFixed(3), +c.b.toFixed(3)] : null;
    const blendName = (b) => {
      if (b === THREE.AdditiveBlending) return 'additive';
      if (b === THREE.MultiplyBlending) return 'multiply';
      if (b === THREE.SubtractiveBlending) return 'subtractive';
      if (b === THREE.NoBlending) return 'none';
      if (b === THREE.NormalBlending) return 'normal';
      if (b === THREE.CustomBlending) return 'custom';
      return `?(${b})`;
    };
    const texInfo = (t) => {
      if (!t) return { bound: false };
      const img = t.image || null;
      return {
        bound: true,
        uuid: t.uuid?.slice(0, 8) || null,
        srcShort: img && img.src ? img.src.split('/').pop()?.split('?')[0] : null,
        w: img?.width || img?.naturalWidth || null,
        h: img?.height || img?.naturalHeight || null,
        repeat: t.repeat ? [t.repeat.x, t.repeat.y] : null,
        offset: t.offset ? [+t.offset.x.toFixed(3), +t.offset.y.toFixed(3)] : null,
        format: t.format,
        colorSpace: t.colorSpace || null,
      };
    };
    const worldBoxSize = (obj) => {
      if (!obj) return null;
      try {
        const b = new THREE.Box3().setFromObject(obj);
        if (b.isEmpty()) return null;
        const s = new THREE.Vector3(); b.getSize(s);
        return [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)];
      } catch { return null; }
    };

    const sprites = (typeof spriteEmitters !== 'undefined' ? spriteEmitters : []).map((e, i) => {
      const layers = (e.layerResources || []).map((res) => ({
        texture: texInfo(res.texture),
        atlasTex: res.atlasTex ? texInfo(res.atlasTex) : null,
        materialColor: colArr(res.mat?.color),
        materialOpacity: res.mat?.opacity ?? null,
        materialTransparent: res.mat?.transparent ?? null,
        blending: blendName(res.mat?.blending),
        depthWrite: res.mat?.depthWrite ?? null,
        layerFlag: res.layerFlag,
      }));
      const aliveParticles = (e.particles || []).filter((p) => p.alive).length;
      return {
        kind: 'sprite',
        runtimeIndex: i,
        emitterDataIndex: e.emDef?.index ?? null,
        sourcePath: e.sourcePath || null,
        visible: !!(e.points && e.points.visible),
        startTimeMs: e.startTimeMs ?? null,
        effectDurationMs: e.effectDurationMs ?? null,
        worldPosition: e.points ? v3(e.points.getWorldPosition(new THREE.Vector3())) : null,
        worldBoxSize: worldBoxSize(e.points),
        attachedTo: e.points && e.points.parent ? (e.points.parent.name || e.points.parent.type) : null,
        layers,
        layerCount: layers.length,
        atlas: { rows: e.uvRows, cols: e.uvCols, cells: e.atlasCellCount, isAtlas: !!e.isAtlas },
        particleCount: e.particleCount ?? null,
        aliveParticles,
        isAdditive: !!e.isAdditive,
        baseTint: colArr(e.baseTint),
        currentColor: colArr(e.currentColor),
        authoredLifetime: e.authoredLifetime ?? null,
        authoredSizeCurve: e.authoredSizeCurve || null,
        authoredSizeKeyframes: e.authoredSizeKeyframes || null,
        authoredAlphaCurve: e.authoredAlphaCurve || null,
        authoredMaxParticles: e.authoredMaxParticles ?? null,
        sizeCurveAuthored: !!e.sizeCurveAuthored,
        flags: {
          noTextureBound: layers.every((l) => !l.texture.bound),
          allWhiteTint: layers.every((l) => {
            const c = l.materialColor || [1, 1, 1];
            return c[0] >= 0.99 && c[1] >= 0.99 && c[2] >= 0.99;
          }),
          collapsedSizeCurve: Array.isArray(e.authoredSizeCurve)
            && e.authoredSizeCurve.length === 3
            && e.authoredSizeCurve.every((v) => v === 0),
          unauthoredSize: !e.sizeCurveAuthored,
        },
      };
    });

    const meshes = (typeof meshObjects !== 'undefined' ? meshObjects : []).map((e, i) => {
      const matsSeen = [];
      const texsSeen = [];
      e.group?.traverse?.((obj) => {
        const m = obj.material;
        const ms = Array.isArray(m) ? m : (m ? [m] : []);
        for (const mat of ms) {
          if (!mat) continue;
          matsSeen.push({
            name: mat.name || null,
            type: mat.type || null,
            color: colArr(mat.color),
            opacity: mat.opacity ?? null,
            transparent: mat.transparent ?? null,
            blending: blendName(mat.blending),
            map: texInfo(mat.map),
            normalMap: mat.normalMap ? texInfo(mat.normalMap) : null,
            emissive: colArr(mat.emissive),
            emissiveMap: mat.emissiveMap ? texInfo(mat.emissiveMap) : null,
          });
          if (mat.map) texsSeen.push(mat.map.image?.src?.split('/').pop()?.split('?')[0] || mat.map.uuid?.slice(0, 8));
        }
      });
      return {
        kind: 'mesh',
        runtimeIndex: i,
        sourcePath: e.sourcePath || null,
        visible: !!(e.group && e.group.visible),
        startTimeMs: e.startTimeMs ?? null,
        worldPosition: e.group ? v3(e.group.getWorldPosition(new THREE.Vector3())) : null,
        worldBoxSize: worldBoxSize(e.group),
        attachedTo: e.group && e.group.parent ? (e.group.parent.name || e.group.parent.type) : null,
        materials: matsSeen,
        materialCount: matsSeen.length,
        texturesBound: texsSeen.filter(Boolean).length,
        flags: {
          noTextureBound: matsSeen.length > 0 && matsSeen.every((m) => !m.map.bound),
          allWhiteTint: matsSeen.length > 0 && matsSeen.every((m) => {
            const c = m.color || [1, 1, 1];
            return c[0] >= 0.99 && c[1] >= 0.99 && c[2] >= 0.99;
          }),
        },
      };
    });

    return {
      counts: {
        sprite: sprites.length,
        mesh: meshes.length,
        track: (typeof trackLines !== 'undefined' ? trackLines.length : 0),
      },
      timeline: {
        timelineMs: typeof timelineMs !== 'undefined' ? timelineMs : null,
        timelineTotalMs: typeof timelineTotalMs !== 'undefined' ? timelineTotalMs : null,
      },
      sprites,
      meshes,
    };
  };

'@

$newTxt = $txt.Replace($marker, $inject + $marker)
if ($newTxt.Length -eq $txt.Length) { throw "no replacement happened" }
[IO.File]::WriteAllText($path, $newTxt, [Text.Encoding]::UTF8)
Write-Host "delta=$($newTxt.Length - $txt.Length) bytes"
