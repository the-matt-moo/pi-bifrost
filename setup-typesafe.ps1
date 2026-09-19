# Setup TypeSafe AI Jev credentials for pi-bifrost
# This script stores your TypeSafe API key in Windows Credential Manager

param(
    [Parameter(Mandatory=$false)]
    [string]$ApiKey
)

$CredentialTarget = "pi-bifrost/jev-api-key"
$CredentialUser = "jev-api-key"

# If no key provided, prompt for it
if (-not $ApiKey) {
    Write-Host "Enter your TypeSafe AI API key (or Ctrl+C to cancel):" -ForegroundColor Cyan
    $SecureKey = Read-Host -AsSecureString
    $ApiKey = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($SecureKey))
}

if (-not $ApiKey) {
    Write-Host "No API key provided. Exiting." -ForegroundColor Red
    exit 1
}

# Remove existing credential if present
$existing = cmdkey /list:$CredentialTarget 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "Removing existing credential..." -ForegroundColor Yellow
    cmdkey /delete:$CredentialTarget | Out-Null
}

# Add the new credential
Write-Host "Storing TypeSafe AI API key in Credential Manager..." -ForegroundColor Cyan
cmdkey /add:$CredentialTarget /user:$CredentialUser /pass:$ApiKey

if ($LASTEXITCODE -eq 0) {
    Write-Host "API key stored successfully in Credential Manager" -ForegroundColor Green
    Write-Host "  Target: $CredentialTarget" -ForegroundColor Gray
    Write-Host "  User: $CredentialUser" -ForegroundColor Gray
    Write-Host "bifrost.json will automatically use this credential." -ForegroundColor Gray
    exit 0
} else {
    Write-Host "Failed to store credential. Check permissions." -ForegroundColor Red
    exit 1
}
