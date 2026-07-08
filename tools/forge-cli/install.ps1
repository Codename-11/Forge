# Forge CLI installer (Windows) — downloads the standalone forge.exe from the
# latest cli-v* GitHub release and adds it to your PATH. No Node required.
#
#   irm https://raw.githubusercontent.com/Codename-11/Forge/main/tools/forge-cli/install.ps1 | iex
#
# Env: FORGE_INSTALL_DIR (default %LOCALAPPDATA%\forge\bin)
$ErrorActionPreference = "Stop"
$Repo = "Codename-11/Forge"
$InstallDir = if ($env:FORGE_INSTALL_DIR) { $env:FORGE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "forge\bin" }

if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "x86")) {
  Write-Error "forge-install: unsupported Windows arch '$env:PROCESSOR_ARCHITECTURE' (only x64 is published)"
}
$asset = "forge-windows-x64.exe"
$headers = @{ "User-Agent" = "forge-install" }

Write-Host "forge-install: resolving latest CLI release..."
$releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers
$rel = $releases | Where-Object { $_.tag_name -like "cli-v*" } | Select-Object -First 1
if (-not $rel) { Write-Error "forge-install: no cli-v* release found" }
$base = "https://github.com/$Repo/releases/download/$($rel.tag_name)"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$dest = Join-Path $InstallDir "forge.exe"
Write-Host "forge-install: downloading $asset ($($rel.tag_name))..."
Invoke-WebRequest -Uri "$base/$asset" -OutFile $dest -UseBasicParsing

# verify checksum (best-effort)
try {
  $sums = (Invoke-WebRequest -Uri "$base/SHA256SUMS" -UseBasicParsing).Content
  $want = $sums -split "`n" |
    Where-Object { $_ -match ([regex]::Escape($asset) + '$') } |
    ForEach-Object { ($_ -split '\s+')[0] } | Select-Object -First 1
  $got = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLower()
  if ($want -and $got -ne $want.Trim().ToLower()) {
    Remove-Item $dest -Force
    Write-Error "forge-install: checksum mismatch for $asset"
  }
} catch { }

# add to user PATH if missing
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
  Write-Host "forge-install: added $InstallDir to your user PATH (restart your shell to pick it up)"
}

Write-Host "forge-install: installed $($rel.tag_name) -> $dest"
Write-Host ""
Write-Host "next:  forge login --url <your Forge URL> --workspace <slug> --token forge_sk_..."
