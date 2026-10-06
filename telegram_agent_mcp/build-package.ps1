param(
    [string]$OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'telegram_agent_mcp.zip')
)

$ErrorActionPreference = 'Stop'
$sourceDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$outputFile = [System.IO.Path]::GetFullPath($OutputPath)
$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("telegram-agent-package-" + [guid]::NewGuid().ToString('N'))
$packageDir = Join-Path $stagingRoot 'telegram_agent_mcp'

$includedFiles = @(
    '.env.example',
    '.gitignore',
    'build-package.ps1',
    'INSTRUCTIONS.md',
    'mcp-config.example.json',
    'mcp-monitor-test.mjs',
    'monitor-host.mjs',
    'package.json',
    'package-lock.json',
    'README.md',
    'RELEASE_NOTES.md',
    'setup.ps1',
    'tsconfig.json'
)

try {
    Push-Location $sourceDir
    try {
        npm run build
    } finally {
        Pop-Location
    }

    New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
    foreach ($relativePath in $includedFiles) {
        $sourcePath = Join-Path $sourceDir $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Required package file is missing: $relativePath"
        }
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $packageDir $relativePath)
    }

    Copy-Item -LiteralPath (Join-Path $sourceDir 'src') -Destination $packageDir -Recurse
    Copy-Item -LiteralPath (Join-Path $sourceDir 'dist') -Destination $packageDir -Recurse
    Copy-Item -LiteralPath (Join-Path $sourceDir 'tests') -Destination $packageDir -Recurse

    $forbidden = Get-ChildItem -LiteralPath $packageDir -Recurse -Force | Where-Object {
        $_.Name -eq '.env' -or $_.Name -eq 'node_modules' -or $_.FullName -match '[\\/]data([\\/]|$)'
    }
    if ($forbidden) {
        throw "Forbidden local files entered the package: $($forbidden.FullName -join ', ')"
    }

    $textExtensions = @('.ts', '.js', '.mjs', '.json', '.md', '.ps1', '.example', '.txt')
    $projectMarker = '_' + 'projects' + '_'
    $usersPath = 'Users' + '\\[^\\]+'
    $drivePath = '[A-Z]:' + '\\(?:Users|Program Files|_' + 'projects' + '_)'
    $pathPattern = '(?i)(' + $drivePath + '|' + $usersPath + '|' + [regex]::Escape($projectMarker) + ')'
    $pathHits = foreach ($file in Get-ChildItem -LiteralPath $packageDir -Recurse -File) {
        if ($textExtensions -contains $file.Extension -or $file.Name -eq '.env.example') {
            if ([System.IO.File]::ReadAllText($file.FullName) -match $pathPattern) { $file.FullName }
        }
    }
    if ($pathHits) {
        throw "A machine-specific path was found in: $($pathHits -join ', ')"
    }

    $outputParent = Split-Path -Parent $outputFile
    New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
    if (Test-Path -LiteralPath $outputFile) { Remove-Item -LiteralPath $outputFile -Force }
    Add-Type -AssemblyName System.IO.Compression
    $zipStream = [System.IO.File]::Open($outputFile, [System.IO.FileMode]::CreateNew)
    $archive = [System.IO.Compression.ZipArchive]::new(
        $zipStream,
        [System.IO.Compression.ZipArchiveMode]::Create,
        $false
    )
    try {
        foreach ($file in Get-ChildItem -LiteralPath $packageDir -Recurse -File) {
            $relativePath = $file.FullName.Substring($stagingRoot.Length).TrimStart('\').Replace('\', '/')
            $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            $fileStream = [System.IO.File]::OpenRead($file.FullName)
            try {
                $fileStream.CopyTo($entryStream)
            } finally {
                $fileStream.Dispose()
                $entryStream.Dispose()
            }
        }
    } finally {
        $archive.Dispose()
        $zipStream.Dispose()
    }
    Write-Host "Clean installation package created: $outputFile"
} finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
