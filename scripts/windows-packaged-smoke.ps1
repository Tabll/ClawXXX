param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [int64]$MaxInstallerBytes = 314572800
)

$ErrorActionPreference = "Stop"
$installer = (Resolve-Path $InstallerPath).Path
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne "Valid") { throw "Installer Authenticode signature is not valid: $($signature.Status)" }
$installerBytes = (Get-Item -LiteralPath $installer).Length
if ($installerBytes -gt $MaxInstallerBytes) {
  throw "Base installer size budget exceeded: $installerBytes > $MaxInstallerBytes"
}

$smokeRoot = Join-Path $env:RUNNER_TEMP "clawx-packaged-smoke"
$installRoot = Join-Path $smokeRoot "install"
$userDataRoot = Join-Path $smokeRoot "user-data"
$sentinelRoot = Join-Path $env:APPDATA "ClawX"
$sentinel = Join-Path $sentinelRoot "packaged-smoke-preserve.txt"
New-Item -ItemType Directory -Path $smokeRoot, $userDataRoot, $sentinelRoot -Force | Out-Null
Set-Content -LiteralPath $sentinel -Value "preserve-on-default-uninstall" -Encoding utf8NoBOM

function Invoke-Installer([string[]]$Arguments) {
  $process = Start-Process -FilePath $installer -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode): $($Arguments -join ' ')" }
}

function Get-OwnedProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
  }
}

try {
  Invoke-Installer @("/S", "/D=$installRoot")
  $appExe = Join-Path $installRoot "ClawX.exe"
  if (-not (Test-Path -LiteralPath $appExe)) { throw "Installed ClawX.exe is missing" }
  $appSignature = Get-AuthenticodeSignature -LiteralPath $appExe
  if ($appSignature.Status -ne "Valid") { throw "Installed ClawX.exe signature is not valid: $($appSignature.Status)" }
  foreach ($forbidden in @("resources\openclaw", "resources\openclaw-plugins", "resources\resources\kernels\openclaw", "resources\resources\kernels\deepseek-harness")) {
    if (Test-Path -LiteralPath (Join-Path $installRoot $forbidden)) { throw "Base install contains optional kernel payload: $forbidden" }
  }

  $previousE2E = $env:CLAWX_E2E
  $previousUserData = $env:CLAWX_USER_DATA_DIR
  $env:CLAWX_E2E = "1"
  $env:CLAWX_USER_DATA_DIR = $userDataRoot
  $app = Start-Process -FilePath $appExe -PassThru
  Start-Sleep -Seconds 8
  if ($app.HasExited) { throw "Packaged ClawX exited during startup with code $($app.ExitCode)" }

  # Reinstall while Electron owns files. The patched NSIS path must terminate
  # the complete app process tree, release locks and finish without reboot.
  Invoke-Installer @("/S", "/D=$installRoot")
  Start-Sleep -Seconds 2
  $remaining = @(Get-OwnedProcesses)
  if ($remaining.Count -ne 0) {
    $remaining | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    throw "ClawX-owned process tree survived the update: $($remaining.ProcessId -join ',')"
  }
  $env:CLAWX_E2E = $previousE2E
  $env:CLAWX_USER_DATA_DIR = $previousUserData

  $uninstaller = Join-Path $installRoot "Uninstall ClawX.exe"
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw "ClawX uninstaller is missing" }
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @("/S", "/SD", "IDNO") -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller failed with exit code $($uninstall.ExitCode)" }
  for ($attempt = 0; $attempt -lt 20 -and (Test-Path -LiteralPath $installRoot); $attempt++) { Start-Sleep -Milliseconds 500 }
  if (Test-Path -LiteralPath $installRoot) { throw "Install directory remains after uninstall: $installRoot" }
  if (-not (Test-Path -LiteralPath $sentinel)) { throw "Default uninstall deleted preserved AppData" }

  $report = [ordered]@{
    ok = $true
    installerBytes = $installerBytes
    maxInstallerBytes = $MaxInstallerBytes
    signature = $signature.Status.ToString()
    updateWithLiveProcess = $true
    processTreeClean = $true
    uninstallPreservedData = $true
  }
  Write-Output ($report | ConvertTo-Json -Compress)
} finally {
  @(Get-OwnedProcesses) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $sentinel -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
