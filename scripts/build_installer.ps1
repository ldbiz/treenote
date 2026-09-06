$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    npm run tauri build -- --no-bundle
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE."
    }

    $releaseExe = Join-Path $repoRoot "src-tauri\target\release\treenote.exe"
    if (-not (Test-Path $releaseExe)) {
        throw "Release binary not found at $releaseExe."
    }

    $stageDir = Join-Path $repoRoot "dist\treenote"
    if (Test-Path $stageDir) {
        Remove-Item $stageDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $stageDir | Out-Null
    Copy-Item $releaseExe $stageDir

    $packageJson = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
    $version = $packageJson.version

    if ($env:ISCC_PATH -and (Test-Path $env:ISCC_PATH)) {
        $isccPath = $env:ISCC_PATH
    }
    elseif ($iscc = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue) {
        $isccPath = $iscc.Source
    }
    else {
        $candidates = @(
            "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
            "${env:ProgramFiles}\Inno Setup 7\ISCC.exe",
            "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe"
        )
        $isccPath = $candidates |
            Where-Object { $_ -and (Test-Path $_) } |
            Select-Object -First 1
    }

    if (-not $isccPath) {
        throw "Inno Setup 7 was not found. Install it from https://jrsoftware.org/isinfo.php."
    }

    & $isccPath "/DMyAppVersion=$version" "installer\treenote.iss"
    if ($LASTEXITCODE -ne 0) {
        throw "Inno Setup failed with exit code $LASTEXITCODE."
    }

    $installerPath = Join-Path $repoRoot "dist\installer\treenote-$version-setup.exe"
    Write-Host "Installer written to $installerPath"
}
finally {
    Pop-Location
}
