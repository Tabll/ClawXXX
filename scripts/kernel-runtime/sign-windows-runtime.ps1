param(
  [Parameter(Mandatory = $true)][string]$KernelRoot,
  [Parameter(Mandatory = $true)][string]$NodeRoot,
  [Parameter(Mandatory = $true)][string]$CertificatePath,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
if (-not $env:CLAWX_WINDOWS_RUNTIME_CERT_PASSWORD) {
  throw "CLAWX_WINDOWS_RUNTIME_CERT_PASSWORD is required"
}

$signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signtool) {
  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter signtool.exe -Recurse |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool) { throw "signtool.exe was not found" }

$roots = @(
  @{ Label = "kernel"; Path = (Resolve-Path $KernelRoot).Path },
  @{ Label = "node"; Path = (Resolve-Path $NodeRoot).Path }
)
$files = foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root.Path -Recurse -File | Where-Object {
    $_.Extension -in @(".exe", ".dll", ".node")
  } | ForEach-Object { @{ Root = $root; File = $_ } }
}
if (-not $files) { throw "No PE executable files were found in the runtime payload" }

$records = @()
foreach ($item in $files) {
  & $signtool sign /fd SHA256 /td SHA256 /tr $TimestampUrl /f $CertificatePath /p $env:CLAWX_WINDOWS_RUNTIME_CERT_PASSWORD $item.File.FullName
  if ($LASTEXITCODE -ne 0) { throw "signtool sign failed: $($item.File.FullName)" }
  & $signtool verify /pa /all /v $item.File.FullName
  if ($LASTEXITCODE -ne 0) { throw "signtool verify failed: $($item.File.FullName)" }
  $signature = Get-AuthenticodeSignature -LiteralPath $item.File.FullName
  if ($signature.Status -ne "Valid") { throw "Invalid Authenticode status for $($item.File.FullName): $($signature.Status)" }
  $records += [ordered]@{
    root = $item.Root.Label
    path = [IO.Path]::GetRelativePath($item.Root.Path, $item.File.FullName).Replace("\", "/")
    sha256 = (Get-FileHash -LiteralPath $item.File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    signerThumbprint = $signature.SignerCertificate.Thumbprint
  }
}

$report = [ordered]@{
  schemaVersion = 1
  ok = $true
  platform = "win32"
  digestAlgorithm = "SHA256"
  timestampUrl = $TimestampUrl
  files = @($records | Sort-Object root, path)
}
$directory = Split-Path -Parent $ReportPath
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$report | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $ReportPath -Encoding utf8NoBOM
Write-Output ($report | ConvertTo-Json -Depth 3 -Compress)
