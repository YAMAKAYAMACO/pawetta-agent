$ErrorActionPreference = 'Stop'

$package = Get-Content (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
$artifact = Join-Path $PSScriptRoot "..\dist\Pawetta-Agent-$($package.version).exe"

if (-not (Test-Path -LiteralPath $artifact)) {
  throw "Release artifact not found: $artifact"
}

$signature = Get-AuthenticodeSignature -LiteralPath $artifact
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
  throw "Release is not signed by a trusted code-signing certificate. Status: $($signature.Status)"
}

$subject = $signature.SignerCertificate.Subject
$expires = $signature.SignerCertificate.NotAfter.ToString('yyyy-MM-dd')
Write-Host "Authenticode signature OK: $subject (expires $expires)"
