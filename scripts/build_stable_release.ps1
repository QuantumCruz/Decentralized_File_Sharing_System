# FileShare 1.0.0 stable Windows build.
# Supports release/v1.0.0 and main.
# Does not delete installed applications or personal application data.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Command,

        [Parameter(Mandatory = $true)]
        [string[]] $Arguments
    )

    Write-Host "`n> $Command $($Arguments -join ' ')" -ForegroundColor Cyan

    & $Command @Arguments

    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Push-Location $root

try {
    $branch = (& git branch --show-current).Trim()

    if (
        $LASTEXITCODE -ne 0 -or
        $branch -notin @('release/v1.0.0', 'main')
    ) {
        throw "Stable builds require release/v1.0.0 or main. Current branch: $branch"
    }

    $required = @(
        'electron-builder.stable.json',
        'public/stable_electron.js',
        'server/stable_server.py',
        'server/server_persistent.py',
        'src/index.js',
        'src/preview_branding.css',
        'assets/FileShare_Icon.ico',
        'assets/FileShare_Icon.png',
        'assets/FileShare_Logo_192.png',
        'assets/FileShare_Logo_512.png',
        'binaries/ipfs.exe',
        'binaries/tor.exe',
        'binaries/cloudflared.exe'
    )

    foreach ($file in $required) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Missing required file: $file"
        }
    }

    $frontend = Get-Content 'src/index.js' -Raw

    if (-not $frontend.Contains("'35300'")) {
        throw "Stable owner port 35300 is missing from React routing."
    }

    $branding = Get-Content 'src/preview_branding.css' -Raw

    if (-not $branding.Contains('url("./fileshare-icon.png")')) {
        throw "React icon reference is incorrect."
    }

    # Install the artwork into its build locations.
    Copy-Item 'assets/FileShare_Icon.ico' 'assets/icon.ico' -Force
    Copy-Item 'assets/FileShare_Icon.ico' 'public/favicon.ico' -Force
    Copy-Item 'assets/FileShare_Icon.png' 'src/fileshare-icon.png' -Force
    Copy-Item 'assets/FileShare_Icon.png' 'public/fileshare-icon.png' -Force
    Copy-Item 'assets/FileShare_Logo_192.png' 'public/logo192.png' -Force
    Copy-Item 'assets/FileShare_Logo_512.png' 'public/logo512.png' -Force

    # Always run the existing security and runtime tests.
    Invoke-Checked 'python' @(
        '-m', 'unittest', 'discover', '-s', 'tests', '-v'
    )

    Invoke-Checked 'node' @(
        '--check',
        'public/stable_electron.js'
    )

    # Delete only generated frontend files.
    foreach ($folder in @('build', 'server/build')) {
        if (Test-Path -LiteralPath $folder) {
            Remove-Item -LiteralPath $folder -Recurse -Force
        }
    }

    # Build the Python backend from current source.
    Invoke-Checked 'python' @(
        '-m', 'PyInstaller',
        '--noconfirm',
        '--clean',
        '--onefile',
        '--windowed',
        '--name', 'stable_server',
        '--paths', '.',
        '--distpath', 'dist-stable/backend',
        '--workpath', 'dist-stable/pyinstaller-work',
        '--specpath', 'dist-stable/spec',
        'server/stable_server.py'
    )

    if (-not (Test-Path 'dist-stable/backend/stable_server.exe' -PathType Leaf)) {
        throw 'The Python backend executable is missing.'
    }

    # Build the React frontend.
    Invoke-Checked 'npm.cmd' @(
        'run',
        'build'
    )

    $frontendFiles = @(
        'server/build/index.html',
        'server/build/favicon.ico',
        'server/build/logo192.png',
        'server/build/logo512.png'
    )

    foreach ($file in $frontendFiles) {
        if (-not (Test-Path $file -PathType Leaf)) {
            throw "Built frontend file missing: $file"
        }
    }

    # Remove old generated stable installers.
    Get-ChildItem 'dist-stable' `
        -Filter 'FileShare-Setup-*.exe' `
        -File `
        -ErrorAction SilentlyContinue |
        Remove-Item -Force

    # Build the actual stable Windows installer.
    Invoke-Checked 'npx.cmd' @(
        'electron-builder',
        '--win',
        'nsis',
        '--x64',
        '--config',
        'electron-builder.stable.json'
    )

    $packaged = @(
        'dist-stable/win-unpacked/FileShare by QuantumCruz.exe',
        'dist-stable/win-unpacked/resources/backend/stable_server.exe',
        'dist-stable/win-unpacked/resources/binaries/ipfs.exe',
        'dist-stable/win-unpacked/resources/binaries/tor.exe',
        'dist-stable/win-unpacked/resources/binaries/cloudflared.exe',
        'dist-stable/win-unpacked/resources/server/build/index.html',
        'dist-stable/win-unpacked/resources/assets/icon.ico'
    )

    foreach ($file in $packaged) {
        if (-not (Test-Path $file -PathType Leaf)) {
            throw "Incomplete packaged application: $file"
        }
    }

    $installers = @(
        Get-ChildItem 'dist-stable' `
            -Filter 'FileShare-Setup-1.0.0-x64.exe' `
            -File
    )

    if ($installers.Count -ne 1) {
        throw 'Expected exactly one stable Windows installer.'
    }

    Write-Host "`nFILESHARE STABLE BUILD SUCCESSFUL" -ForegroundColor Green
    Write-Host "Installer: $($installers[0].FullName)"
    Write-Host "Size: $([math]::Round($installers[0].Length / 1MB, 2)) MB"

    Get-FileHash $installers[0].FullName -Algorithm SHA256 |
        Format-List Algorithm, Hash, Path

    Write-Host 'Build complete. Existing application data remains untouched.'
}
finally {
    Pop-Location
}