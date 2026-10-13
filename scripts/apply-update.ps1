param(
  [Parameter(Mandatory = $true)][int]$WaitPid,
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Dest,
  [Parameter(Mandatory = $true)][string]$Bat,
  [Parameter(Mandatory = $true)][string]$Work,
  [switch]$CopyOnly
)
$ErrorActionPreference = 'Stop'
$logDir = Join-Path $Dest 'data'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'update.log'
function Write-Log([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $log -Encoding UTF8 -Value $line
}
try {
  if ($WaitPid -gt 0) {
    $deadline = (Get-Date).AddMinutes(2)
    while (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) {
      if ((Get-Date) -gt $deadline) { throw "timed out waiting for $WaitPid" }
      Start-Sleep -Milliseconds 300
    }
    Start-Sleep -Milliseconds 400
  }
  & robocopy.exe $Source $Dest /E /XD data node_modules .git /XF *.log /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) { throw "robocopy $LASTEXITCODE" }
  Write-Log "copied"
  if ($CopyOnly) { exit 0 }
  Set-Location -LiteralPath $Dest
  & npm.cmd install --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm install $LASTEXITCODE" }
  Write-Log "installed"
  Start-Process -FilePath $Bat -WorkingDirectory $Dest
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  Write-Log $_.Exception.Message
  Write-Host $_.Exception.Message
  if (-not $CopyOnly) { cmd /c pause }
  exit 1
}
