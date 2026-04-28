$ErrorActionPreference = 'Stop'
$path = 'public\js\actor-animation-player.js'
$txt = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)

if ($txt.Contains('pssEmitterTexturePaths')) {
  Write-Host 'already-patched'
  exit 0
}

$old = @"
    for (const { mat: material, i: slotIndex } of slots) {
      if (!material) continue;

      const meshMaterialMeta = material.userData?.pssMaterial;
      if (!meshMaterialMeta || typeof meshMaterialMeta !== 'object') continue;
"@

$new = @"
    // Fallback texture paths embedded directly in the type-2 PSS mesh-emitter
    // block (server now extracts these via findPaths(/tga|dds|png/)). Used
    // when no JsonInspack companion provides authoritative material params —
    // common for PSS particle meshes whose .Mesh ships without companion.
    const pssEmitterTexturePaths = Array.isArray(meshAsset?.texturePaths)
      ? meshAsset.texturePaths : [];

    for (const { mat: material, i: slotIndex } of slots) {
      if (!material) continue;

      const meshMaterialMeta = material.userData?.pssMaterial;
      if (!meshMaterialMeta || typeof meshMaterialMeta !== 'object') {
        // No JsonInspack-derived material: fall back to the texture path
        // embedded inline in the PSS type-2 block. Default to additive
        // MeshBasicMaterial — matches the engine's particle-mesh convention
        // (KE3D_ParticleMeshQuoteLauncher) and avoids unlit-StandardMaterial
        // appearing solid white when no scene lights exist.
        const embeddedTexPath = pssEmitterTexturePaths[0] || null;
        if (!embeddedTexPath) continue;
        const embeddedTex = await loadPssMeshTextureByPath(embeddedTexPath, 'color');
        if (!embeddedTex) continue;
        const tintHex = pssEmitterTint ? pssEmitterTint.getHex() : 0xffffff;
        const fallbackMat = new THREE.MeshBasicMaterial({
          map: embeddedTex,
          color: tintHex,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        fallbackMat.userData = material.userData;
        if (slotIndex !== null) {
          mesh.material[slotIndex] = fallbackMat;
        } else {
          mesh.material = fallbackMat;
        }
        material.dispose();
        continue;
      }
"@

if (-not $txt.Contains($old)) {
  Write-Error 'old block not found verbatim'
  exit 2
}
$before = $txt.Length
$txt = $txt.Replace($old, $new)
[IO.File]::WriteAllText($path, $txt, [Text.UTF8Encoding]::new($false))
Write-Host ("delta=$($txt.Length - $before) bytes")
