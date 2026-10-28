# Developer-only helper for PR #35 empty-note cleanup manual testing.
param(
    [switch]$Reset,
    [switch]$PurgeBackups,
    [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PyScript = Join-Path $ScriptDir "prepare_empty_cleanup_notebook.py"

if (-not (Test-Path -LiteralPath $PyScript)) {
    Write-Error "Missing $PyScript"
}

$python = $null
foreach ($candidate in @("py -3", "python")) {
    $exe = $candidate.Split(" ")[0]
    if (Get-Command $exe -ErrorAction SilentlyContinue) {
        $python = $candidate
        break
    }
}
if (-not $python) {
    Write-Error "Python 3 is required (py -3 or python)."
}

$pyArgs = @($PyScript)
if ($VerifyOnly) { $pyArgs += "--verify-only" }
if ($Reset) { $pyArgs += "--reset" }
if ($PurgeBackups) { $pyArgs += "--purge-backups" }

if ($python -eq "py -3") {
    & py -3 @pyArgs
} else {
    & python @pyArgs
}
exit $LASTEXITCODE
