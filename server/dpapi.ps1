param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [Parameter(Mandatory = $true)][string]$InFile,
  [Parameter(Mandatory = $true)][string]$OutFile
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
$b64 = [System.IO.File]::ReadAllText($InFile, $utf8).Trim()
Add-Type -AssemblyName System.Security
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Mode -eq 'protect') {
  $bytes = [Convert]::FromBase64String($b64)
  $prot = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
  [System.IO.File]::WriteAllText($OutFile, [Convert]::ToBase64String($prot), $utf8)
} else {
  $prot = [Convert]::FromBase64String($b64)
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect($prot, $null, $scope)
  [System.IO.File]::WriteAllText($OutFile, [Convert]::ToBase64String($bytes), $utf8)
}
