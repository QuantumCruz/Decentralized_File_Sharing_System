# FileShare Preview — verified Windows release-candidate build.
# Run only from the isolated security/stage1 checkout.
# Never touches the original installed FileShare or its user data.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Command,

        [Parameter(Mandatory = $true)]
        [string[]] $CommandArgs
    )

    Write-Host "`n> $Command $($CommandArgs -join ' ')" -ForegroundColor Cyan

    & $Command @CommandArgs

    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Push-Location $root

try {
    Write-Host "`nFileShare Preview release build" -ForegroundColor Cyan

    if (-not (Test-Path ".git" -PathType Container)) {
        throw "Not a Git checkout."
    }

    $branch = (& git branch --show-current).Trim()

    if ($LASTEXITCODE -ne 0 -or $branch -ne "security/stage1") {
        throw "Expected security/stage1 branch. Found: $branch"
    }

    $requiredSources = @(
        "electron-builder.preview.json",
        "public\preview_electron.js",
        "server\preview_server.py",
        "server\server_persistent.py",
        "src\index.js",
        "src\preview_branding.css",
        "assets\FileShare_Icon.ico",
        "assets\FileShare_Icon.png",
        "assets\FileShare_Logo_192.png",
        "assets\FileShare_Logo_512.png",
        "binaries\ipfs.exe",
        "binaries\tor.exe",
        "binaries\cloudflared.exe"
    )

    foreach ($file in $requiredSources) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Required file is missing: $file"
        }
    }

    $css = Get-Content "src\preview_branding.css" -Raw

    if (-not $css.Contains('url("./fileshare-icon.png")')) {
        throw "Fix src/preview_branding.css to use the relative icon URL before building."
    }

    $frontendEntry = Get-Content "src\index.js" -Raw

    if (-not $frontendEntry.Contains("25300")) {
        throw "React frontend does not recognize the Preview owner port."
    }

    # Install the source artwork into the expected build locations.
    Copy-Item "assets\FileShare_Icon.ico" "assets\icon.ico" -Force
    Copy-Item "assets\FileShare_Icon.ico" "public\favicon.ico" -Force
    Copy-Item "assets\FileShare_Icon.png" "src\fileshare-icon.png" -Force
    Copy-Item "assets\FileShare_Icon.png" "public\fileshare-icon.png" -Force
    Copy-Item "assets\FileShare_Logo_192.png" "public\logo192.png" -Force
    Copy-Item "assets\FileShare_Logo_512.png" "public\logo512.png" -Force

    Write-Host "`nIcon assets verified." -ForegroundColor Green

    # Validate before deleting any generated outputs.
    Invoke-Checked "python" @(
        "-m", "unittest", "discover", "-s", "tests", "-v"
    )

    Invoke-Checked "node" @(
        "--check", "public\preview_electron.js"
    )

    # Only generated React artifacts are removed.
    # No databases, IPFS repositories or original installations are touched.
    foreach ($folder in @("build", "server\build")) {
        if (Test-Path $folder) {
            Remove-Item -LiteralPath $folder -Recurse -Force
            Write-Host "Cleaned generated folder: $folder"
        }
    }

    # Build Python fresh, preventing stale backend packaging.
    Invoke-Checked "python" @(
        "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--windowed",
        "--name", "preview_server",
        "--paths", ".",
        "--distpath", "dist-preview\backend",
        "--workpath", "dist-preview\pyinstaller-work",
        "--specpath", "dist-preview\spec",
        "server\preview_server.py"
    )

    if (-not (Test-Path "dist-preview\backend\preview_server.exe")) {
        throw "Bundled preview backend was not created."
    }

    # Produce fresh frontend assets.
    Invoke-Checked "npm.cmd" @(
        "run", "build"
    )

    foreach ($file in @(
        "server\build\index.html",
        "server\build\favicon.ico",
        "server\build\logo192.png",
        "server\build\logo512.png"
    )) {
        if (-not (Test-Path $file)) {
            throw "React build is missing: $file"
        }
    }

    # Remove only previous generated Preview installers.
    # Preserve the backend and all profile data.
    Get-ChildItem "dist-preview" `
        -Filter "FileShare-Preview-Setup-*.exe" `
        -File `
        -ErrorAction SilentlyContinue |
        Remove-Item -Force

    # Build the separately identified NSIS installer.
    Invoke-Checked "npx.cmd" @(
        "electron-builder",
        "--win",
        "nsis",
        "--x64",
        "--config",
        "electron-builder.preview.json"
    )

    $packagedFiles = @(
        "dist-preview\win-unpacked\FileShare Preview.exe",
        "dist-preview\win-unpacked\resources\backend\preview_server.exe",
        "dist-preview\win-unpacked\resources\binaries\ipfs.exe",
        "dist-preview\win-unpacked\resources\binaries\tor.exe",
        "dist-preview\win-unpacked\resources\server\build\index.html"
    )

    foreach ($file in $packagedFiles) {
        if (-not (Test-Path $file -PathType Leaf)) {
            throw "Packaged application is incomplete: $file"
        }
    }

    $installers = @(
        Get-ChildItem "dist-preview" `
            -Filter "FileShare-Preview-Setup-*.exe" `
            -File
    )

    if ($installers.Count -ne 1) {
        throw "Expected exactly one freshly built Preview installer."
    }

    Write-Host "`nBUILD SUCCESSFUL" -ForegroundColor Green
    Write-Host "Installer: $($installers[0].FullName)"
    Write-Host "Size: $([math]::Round($installers[0].Length / 1MB, 1)) MB"
    Write-Host "`nOriginal FileShare installation remains untouched."
    Write-Host "Installer still requires installation and sharing verification."
}
finally {
    Pop-Location
}