# Install dsh-wecom-plugin into a DSH Desktop profile.
#
#   .\install.ps1 -BotId "aib..." -Secret "gPJ..." -AllowUsers "zhangsan"
#   .\install.ps1                     # prompts for the credentials
#   .\install.ps1 -Package "dsh-wecom-plugin"   # install the published npm package
#   .\install.ps1 -Uninstall
#
# The plugin must be added through "insert:"; a bare top-level "- id:" would be
# treated as an override of a non-existent row and silently ignored by the loader.
#
# ASCII-only on purpose: Windows PowerShell 5.1 misreads BOM-less UTF-8 .ps1 files.
param(
  [string]$BotId = "",
  [string]$Secret = "",
  [string]$AllowUsers = "",
  [string]$WsUrl = "",
  [string]$Provider = "",
  [string]$Model = "",
  [string]$NewSessionCwd = "",
  [string]$BindingsPath = "",
  [string]$Profile = "desktop",
  [string]$Package = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$pluginDir = $PSScriptRoot

# Locate the dsh CLI: explicit override, then the bundled Desktop path, then PATH.
$dsh = $env:DSH_CLI
if (-not $dsh) {
  $candidate = Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
  if (Test-Path $candidate) { $dsh = $candidate }
}
if (-not $dsh) {
  $found = Get-Command dsh -ErrorAction SilentlyContinue
  if ($found) { $dsh = $found.Source }
}
if (-not $dsh) { throw "dsh CLI not found. Set `$env:DSH_CLI or install DeepSeek Harness Desktop first." }

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$patchPath = Join-Path $profileDir "cordis.patch.yml"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$markerStart = "# >>> wecom-bridge (managed by install.ps1)"
$markerEnd = "# <<< wecom-bridge"

if (-not (Test-Path $patchPath)) { throw "profile config not found: $patchPath (has the desktop app been started once?)" }

function Read-Text($path) { return [System.IO.File]::ReadAllText($path) }
function Write-Text($path, $text) { [System.IO.File]::WriteAllText($path, $text, $script:utf8NoBom) }

# Strip both shapes we have ever written: the delimited managed block, and the
# legacy top-level "- id: wecom-bridge" block (indented config lines, no dashes).
function Strip-WecomBlock([string]$text) {
  $lines = $text -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  $inManaged = $false
  $inLegacy = $false
  foreach ($line in $lines) {
    if ($line.Trim() -eq $script:markerStart) { $inManaged = $true; continue }
    if ($line.Trim() -eq $script:markerEnd) { $inManaged = $false; continue }
    if ($inManaged) { continue }
    if ($line -match '^\s*-\s*id:\s*wecom-bridge\s*$') { $inLegacy = $true; continue }
    if ($inLegacy) {
      if ($line -match '^\s*-\s' -or $line -match '^\s*#') { $inLegacy = $false } else { continue }
    }
    $out.Add($line)
  }
  return ($out -join "`r`n")
}

# Credentials pasted across line breaks arrive with embedded CR/LF: strip all
# whitespace, they never legitimately contain any.
$BotId = ($BotId -replace '\s+', '')
$Secret = ($Secret -replace '\s+', '')

if (-not $Uninstall) {
  if (-not $BotId) { $BotId = ((Read-Host "BotId") -replace '\s+', '') }
  if (-not $Secret) { $Secret = ((Read-Host "Secret") -replace '\s+', '') }
  if (-not $BotId) { throw "BotId is required." }
  if (-not $Secret) { throw "Secret is required." }
}

$current = Read-Text $patchPath
$hadBlock = $current -match 'wecom-bridge'

if ($Uninstall) {
  if (-not $hadBlock) { Write-Host "No wecom-bridge block in $patchPath - nothing to do."; return }
  $stripped = (Strip-WecomBlock $current).TrimEnd()
  if (-not ($stripped -match '\S')) { $stripped = "[]" }
  Write-Text $patchPath ($stripped + "`r`n")
  Write-Host "Removed the wecom-bridge block. Restart the desktop app to apply."
  return
}

Write-Host "1/2 Installing plugin into profile '$Profile' ..."
if ($Package) {
  # Published package mode: install from npm and reference it by bare name.
  Write-Host "     package: $Package"
  & $dsh plugin --profile $Profile add $Package
  if ($LASTEXITCODE -ne 0) {
    throw "dsh plugin add $Package failed (exit $LASTEXITCODE). See output above."
  }
  $entryName = $Package
} else {
  # Local directory mode: link this checkout and reference it by absolute path.
  # The launcher builds one immutable runtime resolution from the installation
  # and the bundle dependency graph, so a profile-local link is not guaranteed
  # to be part of it. Paths are explicitly supported for inserted rows.
  Write-Host "     source: $pluginDir"
  $linked = Test-Path (Join-Path $profileDir "node_modules\dsh-wecom-plugin")
  if ($linked) {
    Write-Host "     already linked, skipping pnpm"
  } else {
    & $dsh plugin --profile $Profile add $pluginDir
    if ($LASTEXITCODE -ne 0) {
      $dotted = $pluginDir -replace '\\', '/'
      Write-Host "dsh plugin add failed (exit $LASTEXITCODE). Manual steps:" -ForegroundColor Yellow
      Write-Host "  1) edit $profileDir\package.json"
      Write-Host "     add to dependencies:  `"dsh-wecom-plugin`": `"file:$dotted`""
      Write-Host "  2) run:  & `"$dsh`" plugin --profile $Profile install"
      throw "Install did not finish."
    }
  }
  $entryName = (($pluginDir -replace '\\', '/').TrimEnd('/')) + '/lib/index.js'
}

Write-Host "2/2 Writing the insert block ..."
$stripped = (Strip-WecomBlock $current).TrimEnd()
if ($stripped.Trim() -eq "[]") { $stripped = "" }   # empty patch must stay empty, not keep [] before the block
if (-not ($stripped -match '\S')) { $stripped = "" }

$quoted = @()
foreach ($item in ($AllowUsers -split '[,\s]+')) {
  $trimmed = $item.Trim()
  if ($trimmed) { $quoted += '"' + $trimmed + '"' }
}
$allowList = '[' + ($quoted -join ', ') + ']'

$configLines = @()
$configLines += '        botId: "' + $BotId + '"'
$configLines += '        secret: "' + $Secret + '"'
$configLines += '        allowUsers: ' + $allowList
if ($WsUrl)   { $configLines += '        wsUrl: "' + ($WsUrl -replace '\s+', '') + '"' }
if ($Provider) { $configLines += '        provider: "' + $Provider + '"' }
if ($Model)   { $configLines += '        model: "' + $Model + '"' }
if ($NewSessionCwd) { $configLines += '        newSessionCwd: "' + $NewSessionCwd + '"' }
if ($BindingsPath)  { $configLines += '        bindingsPath: "' + $BindingsPath + '"' }

$block = $markerStart + "`r`n" + "- insert:`r`n"
$block += "    - id: wecom-bridge`r`n"
$block += '      name: "' + $entryName + '"' + "`r`n"
$block += "      config:`r`n"
$block += ($configLines -join "`r`n") + "`r`n"
$block += $markerEnd

Write-Text $patchPath ($stripped + "`r`n`r`n" + $block + "`r`n")
Write-Host "     wrote $patchPath"

# Verify no line-broken values (the failure mode that broke profile parsing).
$verify = Read-Text $patchPath
$bad = @()
if ($verify -notmatch '(?m)^\s*botId:\s*"\S+"\s*$') { $bad += 'botId' }
if ($verify -notmatch '(?m)^\s*secret:\s*"\S+"\s*$') { $bad += 'secret' }
if ($bad.Count -gt 0) {
  Write-Host "ERROR: broken lines in $patchPath : $($bad -join ', ')" -ForegroundColor Red
  Write-Host "Each value must sit on one line, e.g.  botId: `"aib...`"" -ForegroundColor Yellow
  throw "Verification failed; fix the file before restarting the app."
}
Write-Host "     verified: botId/secret are single-line"

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Cyan
Write-Host "  1) stop any other WeCom connection (an older standalone bridge would kick this one)"
Write-Host "  2) restart DeepSeek Harness (or wait for dsh-hmr to reload the profile)"
Write-Host "  3) in WeCom send /ping, then /sessions and /debug"
Write-Host ""
Write-Host "Load diagnostics land in $env:USERPROFILE\.dsh\wecom-plugin.log"
