param(
    [string]$McpDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$McpDir = [System.IO.Path]::GetFullPath($McpDir)
$envPath = Join-Path $McpDir '.env'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js not found. Install Node.js 20 or newer and run setup again.'
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm not found. Check the Node.js installation and run setup again.'
}

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required. Installed version: $(node --version)"
}

function Read-EnvValue([string]$Name) {
    if (-not (Test-Path -LiteralPath $envPath)) { return $null }
    $line = Select-String -LiteralPath $envPath -Pattern "^$Name=(.*)$" | Select-Object -First 1
    if ($null -eq $line) { return $null }
    return $line.Matches[0].Groups[1].Value.Trim()
}

function Ask-IfMissing([string]$Name, [string]$Prompt, [string]$Default = '') {
    $value = Read-EnvValue $Name
    if ([string]::IsNullOrWhiteSpace($value)) {
        $suffix = if ($Default) { " [$Default]" } else { '' }
        $value = Read-Host "$Prompt$suffix"
        if ([string]::IsNullOrWhiteSpace($value) -and $Default) { $value = $Default }
    }
    return $value
}

function Ask-SecretIfMissing([string]$Name, [string]$Prompt) {
    $value = Read-EnvValue $Name
    if ([string]::IsNullOrWhiteSpace($value)) {
        $secureValue = Read-Host $Prompt -AsSecureString
        $value = [System.Net.NetworkCredential]::new('', $secureValue).Password
    }
    return $value
}

$token = Ask-SecretIfMissing 'TELEGRAM_BOT_TOKEN' 'Enter TELEGRAM_BOT_TOKEN'
$chatId = Ask-IfMissing 'TELEGRAM_CHAT_ID' 'Enter TELEGRAM_CHAT_ID (for example -1001234567890)'
$useFilter = Ask-IfMissing 'TELEGRAM_USE_PREFIX_FILTER' 'Use prefix filter? true/false' 'true'
$prefix = Ask-IfMissing 'TELEGRAM_COMMAND_PREFIX' 'Enter command prefix' 'cod'
$stateFile = Ask-IfMissing 'TELEGRAM_STATE_FILE' 'Enter state file' 'data/state.json'
$monitorEnabled = Read-EnvValue 'TELEGRAM_MONITOR_ENABLED'
if ([string]::IsNullOrWhiteSpace($monitorEnabled)) { $monitorEnabled = 'true' }
$monitorStateFile = Read-EnvValue 'TELEGRAM_MONITOR_STATE_FILE'
if ([string]::IsNullOrWhiteSpace($monitorStateFile)) { $monitorStateFile = 'data/monitor-state.json' }
$monitorPollTimeout = Read-EnvValue 'TELEGRAM_MONITOR_POLL_TIMEOUT'
if ([string]::IsNullOrWhiteSpace($monitorPollTimeout)) { $monitorPollTimeout = '30' }

if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($chatId)) {
    throw 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.'
}
if ($useFilter -notin @('true', 'false')) {
    throw 'TELEGRAM_USE_PREFIX_FILTER must be true or false.'
}
if ($useFilter -eq 'true' -and [string]::IsNullOrWhiteSpace($prefix)) {
    throw 'TELEGRAM_COMMAND_PREFIX cannot be empty while prefix filtering is enabled.'
}
$parsedPollTimeout = 0
if (-not [int]::TryParse($monitorPollTimeout, [ref]$parsedPollTimeout) -or $parsedPollTimeout -lt 1 -or $parsedPollTimeout -gt 50) {
    throw 'TELEGRAM_MONITOR_POLL_TIMEOUT must be an integer from 1 to 50.'
}

$envText = @"
TELEGRAM_BOT_TOKEN=$token
TELEGRAM_CHAT_ID=$chatId
TELEGRAM_USE_PREFIX_FILTER=$useFilter
TELEGRAM_COMMAND_PREFIX=$prefix
TELEGRAM_STATE_FILE=$stateFile
TELEGRAM_MONITOR_ENABLED=$monitorEnabled
TELEGRAM_MONITOR_STATE_FILE=$monitorStateFile
TELEGRAM_MONITOR_POLL_TIMEOUT=$monitorPollTimeout
"@

[System.IO.File]::WriteAllText($envPath, $envText.Trim() + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
[System.IO.Directory]::CreateDirectory((Join-Path $McpDir 'data')) | Out-Null

Push-Location $McpDir
try {
    if (Test-Path -LiteralPath (Join-Path $McpDir 'package-lock.json')) {
        npm ci
    } else {
        npm install
    }
    npm run build
} finally {
    Pop-Location
}

Write-Host "Telegram MCP configured and built: $McpDir"
Write-Host 'The agent can now add it to its MCP configuration and call telegram_status.'
