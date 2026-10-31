# FileShare stable Windows release builder.
# Compatible with Windows PowerShell 5.1.
# Builds the version declared in package.json.
# Preserves installed applications and application data.

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

function Get-PackageVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string] $JsonFile
    )

    if (-not (Test-Path -LiteralPath $JsonFile -PathType Leaf)) {
        throw "Missing file: $JsonFile"
    }

    $content = Get-Content -LiteralPath $JsonFile -Raw

    # Both npm metadata files declare their top-level version
    # before any nested dependency version fields.
    # Read only that first version field.
    $pattern = '(?m)^[ \t]*"version"[ \t]*:[ \t]*"(?<version>[0-9]+\.[0-9]+\.[0-9]+)"'

    $result = [regex]::Match($content, $pattern)

    if (-not $result.Success) {
        throw "Cannot read application version from $JsonFile"
    }

    return $result.Groups['version'].Value
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Push-Location $root

try {
    Write-Host "`nFileShare Stable Release Builder" -ForegroundColor Cyan

    $branch = (& git branch --show-current).Trim()

    if (
        $LASTEXITCODE -ne 0 -or
        $branch -notin @('main', 'release/v1.0.0')
    ) {
        throw "Unexpected Git branch: $branch"
    }

    # Read application versions without parsing the entire lockfile.
    $version = Get-PackageVersion 'package.json'
    $lockedVersion = Get-PackageVersion 'package-lock.json'

    if ($version -ne $lockedVersion) {
        throw "Version mismatch: $version versus $lockedVersion"
    }

    Write-Host "Building FileShare v$version" -ForegroundColor Green

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
            throw "Required file missing: $file"
        }
    }

    # Verify the specific Tor compatibility fix.
    $torVersion = (& '.\binaries\tor.exe' --version) -join ' '

    if (
        $LASTEXITCODE -ne 0 -or
        $torVersion -notmatch '0\.4\.9\.15'
    ) {
        throw "Expected Tor 0.4.9.15. Found: $torVersion"
    }

    Write-Host "Tor verified: $torVersion" -ForegroundColor Green

    # Ensure the existing IPFS binary remains unchanged in version.
    $ipfsVersion = (& '.\binaries\ipfs.exe' version) -join ' '

    if (
        $LASTEXITCODE -ne 0 -or
        $ipfsVersion -notmatch '0\.7\.0'
    ) {
        throw "Expected go-ipfs 0.7.0. Found: $ipfsVersion"
    }

    Write-Host "IPFS verified: $ipfsVersion" -ForegroundColor Green

    # Verify stable frontend routing.
    $frontend = Get-Content 'src/index.js' -Raw

    if (-not $frontend.Contains("'35300'")) {
        throw "Stable owner port 35300 is missing."
    }

    $branding = Get-Content 'src/preview_branding.css' -Raw

    if (-not $branding.Contains('url("./fileshare-icon.png")')) {
        throw "Invalid branding icon reference."
    }

    # Prepare branding assets.
    Copy-Item 'assets/FileShare_Icon.ico' 'assets/icon.ico' -Force
    Copy-Item 'assets/FileShare_Icon.ico' 'public/favicon.ico' -Force
    Copy-Item 'assets/FileShare_Icon.png' 'src/fileshare-icon.png' -Force
    Copy-Item 'assets/FileShare_Icon.png' 'public/fileshare-icon.png' -Force
    Copy-Item 'assets/FileShare_Logo_192.png' 'public/logo192.png' -Force
    Copy-Item 'assets/FileShare_Logo_512.png' 'public/logo512.png' -Force

    # Run tests before removing any generated files.
    Invoke-Checked 'python' @(
        '-m',
        'unittest',
        'discover',
        '-s',
        'tests',
        '-v'
    )

    Invoke-Checked 'node' @(
        '--check',
        'public/stable_electron.js'
    )

    # Remove only generated frontend builds.
    foreach ($folder in @('build', 'server/build')) {
        if (Test-Path -LiteralPath $folder) {
            Remove-Item -LiteralPath $folder -Recurse -Force
        }
    }

    # Build the backend.
    Invoke-Checked 'python' @(
        '-m',
        'PyInstaller',
        '--noconfirm',
        '--clean',
        '--onefile',
        '--windowed',
        '--name',
        'stable_server',
        '--paths',
        '.',
        '--distpath',
        'dist-stable/backend',
        '--workpath',
        'dist-stable/pyinstaller-work',
        '--specpath',
        'dist-stable/spec',
        'server/stable_server.py'
    )

    if (-not (Test-Path 'dist-stable/backend/stable_server.exe' -PathType Leaf)) {
        throw "Backend executable was not generated."
    }

    # Compile the frontend.
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
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Missing frontend build file: $file"
        }
    }

    # Generate the installer filename from the current version.
    $installerName = "FileShare-Setup-$version-x64.exe"
    $installerPath = Join-Path 'dist-stable' $installerName

    if (Test-Path -LiteralPath $installerPath -PathType Leaf) {
        Remove-Item -LiteralPath $installerPath -Force
    }

    # Package the stable Windows application.
    Invoke-Checked 'npx.cmd' @(
        'electron-builder',
        '--win',
        'nsis',
        '--x64',
        '--config',
        'electron-builder.stable.json'
    )

    $resources = 'dist-stable/win-unpacked/resources'

    $packagedFiles = @(
        'dist-stable/win-unpacked/FileShare by QuantumCruz.exe',
        "$resources/backend/stable_server.exe",
        "$resources/binaries/ipfs.exe",
        "$resources/binaries/tor.exe",
        "$resources/binaries/cloudflared.exe",
        "$resources/server/build/index.html",
        "$resources/assets/icon.ico"
    )

    foreach ($file in $packagedFiles) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Packaged component missing: $file"
        }
    }

    # Verify the exact Tor and IPFS executables are packaged.
    foreach ($binary in @('tor.exe', 'ipfs.exe')) {
        $source = Join-Path 'binaries' $binary
        $destination = Join-Path "$resources/binaries" $binary

        $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
        $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash

        if ($sourceHash -ne $destinationHash) {
            throw "Packaged $binary does not match the source executable."
        }
    }

    if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
        throw "Installer missing: $installerName"
    }

    $installer = Get-Item -LiteralPath $installerPath

    Write-Host "`nFILESHARE v$version BUILD SUCCESSFUL" -ForegroundColor Green
    Write-Host "Installer: $($installer.FullName)"
    Write-Host "Size: $([math]::Round($installer.Length / 1MB, 2)) MiB"

    Get-FileHash $installer.FullName -Algorithm SHA256 |
        Format-List Algorithm, Hash, Path

    Write-Host "Packaged Tor and IPFS checksums verified."
    Write-Host "Application data was not modified by this build."
}
finally {
    Pop-Location
}