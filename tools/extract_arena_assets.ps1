# Extract all assets needed for 玉门关竞技场 export
# Run from: jx3-web-map-viewer root

$repoRoot = Split-Path $PSScriptRoot -Parent
$dataPath = Join-Path $repoRoot "public\map-data"
$outPath  = Join-Path $repoRoot "public\map-data\arena-assets\玉门关竞技场"

# The 48 GLBs from the export
$meshes = @(
    "cq_玉门关城墙001_001_hd.glb", "cq_玉门关城墙001_002_hd.glb",
    "cq_玉门关城墙001_003_hd.glb", "cq_玉门关城墙001_005_hd.glb",
    "cq_玉门关城墙001_007_hd.glb", "cq_玉门关城墙001_008_hd.glb",
    "jz_xb楼兰哨台001_001_hd.glb", "jz_xb楼兰哨台001_003_hd.glb",
    "jz_xb楼兰哨台001_004_hd.glb", "jz_xb楼兰哨台001_005_hd.glb",
    "jz_xb楼兰哨台001_007_hd.glb", "jz_xb玉门关建筑001_002_hd.glb",
    "jz_xb玉门关建筑001_003sn_hd.glb", "jz_xb玉门关建筑001_003sw_hd.glb",
    "jz_xb玉门关建筑001_004_hd.glb", "jz_xb玉门关建筑002_003_hd.glb",
    "jz_xb玉门关建筑002_006_hd.glb", "jz_xb玉门关建筑002_008_hd.glb",
    "pj_玉门布棚001_hd.glb", "pj_玉门草棚001_hd.glb",
    "sd_崖壁狱门fb_001_hd.glb", "st_mj石头003_003_hd.glb",
    "wj_erg书001_hd.glb", "wj_erg地毯001_hd.glb",
    "wj_erg笔架002_hd.glb", "wj_erg纸张001_hd.glb",
    "wj_中级挂饰004_001_hd.glb", "wj_圆木桶003_hd.glb",
    "wj_壁挂灯笼001_hd.glb", "wj_挂毯001_001_hd.glb",
    "wj_摇钱树001_hd.glb", "wj_木箱001_hd.glb",
    "wj_木箱004_001_hd.glb", "wj_木箱004_002_hd.glb",
    "wj_木箱堆002_hd.glb", "wj_木车002_hd.glb",
    "wj_桌子002_001_hd.glb", "wj_沙包009_01_hd.glb",
    "wj_物什箱014_hd.glb", "wj_破车001_001_hd.glb",
    "xwj_ca柜子003_004_hd.glb", "xwj_xb楼兰墓地001_004_hd.glb",
    "xwj_xb楼兰墓地001_005_hd.glb", "xwj_农家物件008_hd.glb",
    "xwj_扬州路灯002_005a_hd.glb", "xwj_破军物件001_003_hd.glb",
    "xwj_破军物件001_004_hd.glb", "xwj_赌桌002_002_hd.glb"
)

# Read texture-map.json with explicit UTF-8
$texMapJson = [System.IO.File]::ReadAllText("$dataPath\texture-map.json", [System.Text.Encoding]::UTF8)
$texMap = $texMapJson | ConvertFrom-Json

# Collect all needed texture filenames from all subsets
$neededTextures = [System.Collections.Generic.HashSet[string]]::new()
$missingFromMap = [System.Collections.Generic.List[string]]::new()

foreach ($mesh in $meshes) {
    $entry = $texMap.PSObject.Properties[$mesh]
    if (-not $entry) {
        $missingFromMap.Add($mesh)
        continue
    }
    $v = $entry.Value
    # Top-level textures
    if ($v.albedo) { $neededTextures.Add($v.albedo) | Out-Null }
    if ($v.mre)    { $neededTextures.Add($v.mre)    | Out-Null }
    if ($v.normal) { $neededTextures.Add($v.normal) | Out-Null }
    # All subset textures
    if ($v.subsets) {
        foreach ($sub in $v.subsets) {
            if ($sub.albedo) { $neededTextures.Add($sub.albedo) | Out-Null }
            if ($sub.mre)    { $neededTextures.Add($sub.mre)    | Out-Null }
            if ($sub.normal) { $neededTextures.Add($sub.normal) | Out-Null }
        }
    }
}

Write-Host "Meshes with no texture-map entry: $($missingFromMap.Count)"
$missingFromMap | ForEach-Object { Write-Host "  MISSING: $_" }
Write-Host "Unique textures needed: $($neededTextures.Count)"

# Create output dirs
New-Item -ItemType Directory -Force -Path "$outPath\textures" | Out-Null
New-Item -ItemType Directory -Force -Path "$outPath\meshes"   | Out-Null

# Copy textures
$copiedTex = 0; $missingTex = 0
foreach ($tex in $neededTextures) {
    $src = "$dataPath\textures\$tex"
    if (Test-Path $src) {
        Copy-Item $src "$outPath\textures\$tex"
        $copiedTex++
    } else {
        Write-Host "  TEXTURE NOT FOUND: $tex"
        $missingTex++
    }
}
Write-Host "Textures copied: $copiedTex, missing on disk: $missingTex"

# Copy GLBs
$copiedGlb = 0; $missingGlb = 0
foreach ($mesh in $meshes) {
    $src = "$dataPath\meshes\$mesh"
    if (Test-Path $src) {
        Copy-Item $src "$outPath\meshes\$mesh"
        $copiedGlb++
    } else {
        Write-Host "  GLB NOT FOUND: $mesh"
        $missingGlb++
    }
}
Write-Host "GLBs copied: $copiedGlb, missing on disk: $missingGlb"

# Size report
$texSize = (Get-ChildItem "$outPath\textures" -File | Measure-Object -Property Length -Sum).Sum / 1MB
$glbSize = (Get-ChildItem "$outPath\meshes"   -File | Measure-Object -Property Length -Sum).Sum / 1MB
$total = $texSize + $glbSize
$texR = [math]::Round($texSize,1)
$glbR = [math]::Round($glbSize,1)
$totR = [math]::Round($total,1)
Write-Host "Textures: $texR MB | GLBs: $glbR MB | Total: $totR MB"
