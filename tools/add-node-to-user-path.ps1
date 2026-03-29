# Add Node.js folder to current user's PATH permanently (no admin).
# Run from PowerShell where "node -v" already works:
#   powershell -ExecutionPolicy Bypass -File .\tools\add-node-to-user-path.ps1

$ErrorActionPreference = 'Stop'

function Get-NodeDirectory {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $cmd -and $cmd.Source) {
        return (Split-Path -Parent $cmd.Source)
    }
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $candidates = New-Object System.Collections.ArrayList
    [void]$candidates.Add((Join-Path $env:ProgramFiles 'nodejs'))
    if ($pf86) {
        [void]$candidates.Add((Join-Path $pf86 'nodejs'))
    }
    [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs'))
    foreach ($p in $candidates) {
        $exe = Join-Path $p 'node.exe'
        if (Test-Path -LiteralPath $exe) {
            return $p
        }
    }
    return $null
}

$nodeDir = Get-NodeDirectory
if (-not $nodeDir) {
    Write-Host 'ERROR: node.exe not found. Run this script from a shell where node works.' -ForegroundColor Red
    exit 1
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) {
    $userPath = ''
}

$parts = $userPath -split ';' | ForEach-Object { $_.TrimEnd('\') } | Where-Object { $_ -ne '' }
if ($parts -contains $nodeDir) {
    Write-Host "OK: Already in user PATH: $nodeDir" -ForegroundColor Green
    exit 0
}

$newPath = ($userPath.TrimEnd(';') + ';' + $nodeDir).TrimStart(';')
[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')

Write-Host "OK: Added to user PATH: $nodeDir" -ForegroundColor Green
Write-Host 'Restart Cursor completely, then run node -v in its terminal.' -ForegroundColor Yellow
