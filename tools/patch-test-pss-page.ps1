$ErrorActionPreference='Stop'
$f='tests\pss-page.spec.js'
$t=[IO.File]::ReadAllText($f)
$old = "    // Debug panel must be visible by default in PSS-only mode.`r`n" +
       "    await expect(page.locator('#debug-panel')).toBeVisible();`r`n`r`n" +
       "    // Debug body should contain at least one entry after a PSS loads.`r`n" +
       "    const debugBody = page.locator('#debug-body');`r`n" +
       "    await expect(debugBody).not.toBeEmpty({ timeout: 30_000 });`r`n`r`n" +
       "    // Copy button works: click it, ensure no exception. (We can't reliably`r`n" +
       "    // read the OS clipboard in CI; we only check the button state changes`r`n" +
       "    // to `"copied`" or stays clickable.)`r`n" +
       "    const copyBtn = page.locator('#btn-debug-copy');`r`n" +
       "    await expect(copyBtn).toBeVisible();`r`n" +
       "    await copyBtn.click();`r`n" +
       "    // The class either changes to `"copied`" briefly or doesn't — either is fine,`r`n" +
       "    // we just want the button to handle the click without throwing.`r`n"
$new = "    // The new PSS log panel must be visible by default in PSS-only mode.`r`n" +
       "    await expect(page.locator('#pss-log-panel')).toBeVisible();`r`n`r`n" +
       "    // It has exactly two tabs: `"Things went right`" and `"Things went wrong`".`r`n" +
       "    await expect(page.locator('#pss-log-panel .pss-log-tab[data-tab=`"right`"]')).toBeVisible();`r`n" +
       "    await expect(page.locator('#pss-log-panel .pss-log-tab[data-tab=`"wrong`"]')).toBeVisible();`r`n`r`n" +
       "    // Log body should accumulate at least one entry after a PSS loads.`r`n" +
       "    const logBody = page.locator('#pss-log-panel .pss-log-body .pss-log-row');`r`n" +
       "    await expect(logBody.first()).toBeVisible({ timeout: 30_000 });`r`n`r`n" +
       "    // Copy button works: click it without throwing.`r`n" +
       "    const copyBtn = page.locator('#pss-log-copy');`r`n" +
       "    await expect(copyBtn).toBeVisible();`r`n" +
       "    await copyBtn.click();`r`n"
if ($t.Contains($old)) {
  $t2 = $t.Replace($old, $new)
  [IO.File]::WriteAllText($f, $t2, [Text.Encoding]::UTF8)
  Write-Host "patched on disk"
} elseif ($t.Contains('#pss-log-panel')) {
  Write-Host "already patched"
} else {
  # Try LF version
  $oldLf = $old -replace "`r`n", "`n"
  if ($t.Contains($oldLf)) {
    $newLf = $new -replace "`r`n", "`n"
    $t2 = $t.Replace($oldLf, $newLf)
    [IO.File]::WriteAllText($f, $t2, [Text.Encoding]::UTF8)
    Write-Host "patched on disk (LF)"
  } else {
    Write-Host "marker not found"
  }
}
