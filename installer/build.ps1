<#
  Build the MIDI Converter online installer: installer\dist\MIDI-Converter-Setup-<version>.exe

    powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1

  Steps: read the version from midiconv\__init__.py, download uv (cached, checksum-verified), fetch the
  piano samples, make the icon if missing, stage the files, compile the launcher with csc.exe and
  compile the setup with Inno Setup. Windows PowerShell 5.1 compatible. Stops on the first error.
#>
[CmdletBinding()]
param(
    [string]$Python = '',
    [string]$Iscc = (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    [string]$Csc = (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is very slow with the progress bar on
Set-StrictMode -Version 2.0

$UvVersion = '0.13.7'
$UvAsset = 'uv-x86_64-pc-windows-msvc.zip'
$UvSha256 = '0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021'
$UvUrl = "https://github.com/astral-sh/uv/releases/download/$UvVersion/$UvAsset"

$Installer = $PSScriptRoot
$Root = Split-Path -Parent $Installer
$Build = Join-Path $Installer 'build'
$Cache = Join-Path $Build 'cache'
$Stage = Join-Path $Build 'stage'
$Dist = Join-Path $Installer 'dist'
$Icon = Join-Path $Installer 'assets\MIDIConverter.ico'
if (-not $Python) { $Python = Join-Path $Root '.venv\Scripts\python.exe' }

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

# Run a native program; throw if it fails. ErrorActionPreference is relaxed so that output on
# stderr does not count as a PowerShell error in Windows PowerShell 5.1.
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
    if ($code -ne 0) { throw "$([IO.Path]::GetFileName($Exe)) failed with exit code $code" }
}

function Assert-File([string]$Path, [string]$What) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$What not found: $Path" }
}

# Copy a folder tree, without caches and temporary files.
function Copy-Tree([string]$From, [string]$To) {
    if (-not (Test-Path -LiteralPath $From -PathType Container)) { throw "Missing folder: $From" }
    $base = (Resolve-Path -LiteralPath $From).Path.TrimEnd('\')
    $skipExt = @('.pyc', '.pyo', '.part', '.tmp')
    $skipName = @('Thumbs.db', 'desktop.ini', '.DS_Store')
    $count = 0
    Get-ChildItem -LiteralPath $base -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring($base.Length + 1)
        if ($rel -match '(^|\\)__pycache__(\\|$)') { return }
        if ($skipExt -contains $_.Extension.ToLowerInvariant()) { return }
        if ($skipName -contains $_.Name) { return }
        $dest = Join-Path $To $rel
        $dir = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Copy-Item -LiteralPath $_.FullName -Destination $dest
        $count++
    }
    Write-Host ("    {0,5} files  {1}" -f $count, $To.Substring($Stage.Length + 1))
}

# ---------------------------------------------------------------- version
Write-Step 'Reading the version'
$initPy = Join-Path $Root 'midiconv\__init__.py'
Assert-File $initPy 'midiconv\__init__.py'
$m = [regex]::Match([IO.File]::ReadAllText($initPy), '(?m)^__version__\s*=\s*["'']([^"'']+)["'']')
if (-not $m.Success) { throw "__version__ not found in $initPy" }
$Version = $m.Groups[1].Value
$numeric = [regex]::Match($Version, '^\d+(\.\d+){0,3}').Value
if (-not $numeric) { throw "Version '$Version' does not start with a number" }
$parts = @($numeric.Split('.'))
while ($parts.Count -lt 4) { $parts += '0' }
$NumVersion = ($parts[0..3] -join '.')
Write-Host "    $Version ($NumVersion)"

# ---------------------------------------------------------------- tools
Write-Step 'Checking the build tools'
Assert-File $Python 'Python (dev venv)'
Assert-File $Iscc 'Inno Setup compiler (ISCC.exe)'
Assert-File $Csc 'C# compiler (csc.exe)'
Write-Host "    python: $Python"
Write-Host "    iscc:   $Iscc"
Write-Host "    csc:    $Csc"

# ---------------------------------------------------------------- uv
Write-Step "uv $UvVersion"
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
$uvZip = Join-Path $Cache "uv-$UvVersion-x86_64-pc-windows-msvc.zip"
$uvDir = Join-Path $Cache "uv-$UvVersion"
$uvExe = Join-Path $uvDir 'uv.exe'
if ((Test-Path -LiteralPath $uvZip) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $uvZip).Hash -ne $UvSha256.ToUpperInvariant())) {
    Write-Host '    cached archive has the wrong checksum: downloading again'
    Remove-Item -LiteralPath $uvZip -Force
    if (Test-Path -LiteralPath $uvDir) { Remove-Item -LiteralPath $uvDir -Recurse -Force }
}
if (-not (Test-Path -LiteralPath $uvZip)) {
    Write-Host "    downloading $UvUrl"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $part = "$uvZip.part"
    Invoke-WebRequest -Uri $UvUrl -OutFile $part -UseBasicParsing
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash
    if ($hash -ne $UvSha256.ToUpperInvariant()) {
        Remove-Item -LiteralPath $part -Force
        throw "uv download checksum mismatch: got $hash, expected $UvSha256"
    }
    Move-Item -LiteralPath $part -Destination $uvZip -Force
}
if (-not (Test-Path -LiteralPath $uvExe)) {
    if (Test-Path -LiteralPath $uvDir) { Remove-Item -LiteralPath $uvDir -Recurse -Force }
    Expand-Archive -LiteralPath $uvZip -DestinationPath $uvDir -Force
}
Assert-File $uvExe 'uv.exe'
$uvReported = (& $uvExe --version) -join ' '
if ($uvReported -notmatch [regex]::Escape("uv $UvVersion")) { throw "Unexpected uv version: $uvReported" }
Write-Host "    $uvReported"

# ---------------------------------------------------------------- piano samples
Write-Step 'Piano samples (scripts\fetch_piano_samples.py)'
Invoke-Native $Python @((Join-Path $Root 'scripts\fetch_piano_samples.py'))
Write-Host ''
$pianoDir = Join-Path $Root 'web\vendor\piano'
$oggCount = @(Get-ChildItem -LiteralPath $pianoDir -Filter '*.ogg' -File).Count
if ($oggCount -lt 100) { throw "Only $oggCount piano samples in $pianoDir" }
Write-Host "    $oggCount samples"

# ---------------------------------------------------------------- icon
Write-Step 'Icon'
if (-not (Test-Path -LiteralPath $Icon)) {
    Invoke-Native $Python @((Join-Path $Installer 'make_icon.py'), $Icon)
}
Assert-File $Icon 'Icon'
Write-Host "    $Icon"

# ---------------------------------------------------------------- stage
Write-Step 'Staging files'
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
foreach ($d in @('tools', 'assets', 'app')) { New-Item -ItemType Directory -Force -Path (Join-Path $Stage $d) | Out-Null }
Copy-Tree (Join-Path $Root 'midiconv') (Join-Path $Stage 'app\midiconv')
Copy-Tree (Join-Path $Root 'web') (Join-Path $Stage 'app\web')
Copy-Tree (Join-Path $Root 'scripts') (Join-Path $Stage 'app\scripts')
Assert-File (Join-Path $Root 'requirements-runtime.txt') 'requirements-runtime.txt'
Copy-Item -LiteralPath (Join-Path $Root 'requirements-runtime.txt') -Destination (Join-Path $Stage 'app\requirements-runtime.txt')
Copy-Item -LiteralPath $uvExe -Destination (Join-Path $Stage 'tools\uv.exe')
Copy-Item -LiteralPath $Icon -Destination (Join-Path $Stage 'assets\MIDIConverter.ico')
foreach ($required in @('app\midiconv\__main__.py', 'app\scripts\setup_runtime.py', 'app\web\index.html')) {
    Assert-File (Join-Path $Stage $required) $required
}

# ---------------------------------------------------------------- launcher
Write-Step 'Compiling the launcher (MIDI Converter.exe)'
$launcherBuild = Join-Path $Build 'launcher'
New-Item -ItemType Directory -Force -Path $launcherBuild | Out-Null
$versionCs = Join-Path $launcherBuild 'VersionInfo.cs'
$versionSource = @"
// Generated by installer\build.ps1
using System.Reflection;
[assembly: AssemblyTitle("MIDI Converter")]
[assembly: AssemblyDescription("MIDI Converter")]
[assembly: AssemblyProduct("MIDI Converter")]
[assembly: AssemblyCopyright("")]
[assembly: AssemblyVersion("$NumVersion")]
[assembly: AssemblyFileVersion("$NumVersion")]
[assembly: AssemblyInformationalVersion("$Version")]
"@
[IO.File]::WriteAllText($versionCs, $versionSource, (New-Object Text.UTF8Encoding($false)))
$launcherOut = Join-Path $launcherBuild 'MIDIConverter.exe'
if (Test-Path -LiteralPath $launcherOut) { Remove-Item -LiteralPath $launcherOut -Force }
$sources = @(Get-ChildItem -LiteralPath (Join-Path $Installer 'launcher') -Filter '*.cs' -File | ForEach-Object { $_.FullName })
$cscArgs = @(
    '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/warn:4', '/warnaserror+', '/utf8output',
    "/win32icon:$Icon",
    "/win32manifest:$(Join-Path $Installer 'launcher\app.manifest')",
    "/resource:$Icon,MIDIConverter.ico",
    '/reference:System.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    "/out:$launcherOut"
) + $sources + @($versionCs)
Invoke-Native $Csc $cscArgs
Assert-File $launcherOut 'compiled launcher'
Copy-Item -LiteralPath $launcherOut -Destination (Join-Path $Stage 'MIDI Converter.exe')
Write-Host "    $([math]::Round((Get-Item -LiteralPath $launcherOut).Length / 1KB)) KB"

# ---------------------------------------------------------------- setup
Write-Step 'Compiling the setup (Inno Setup)'
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$setupExe = Join-Path $Dist "MIDI-Converter-Setup-$Version.exe"
if (Test-Path -LiteralPath $setupExe) { Remove-Item -LiteralPath $setupExe -Force }
Invoke-Native $Iscc @(
    '/Q',
    "/DAppVersion=$Version", "/DNumVersion=$NumVersion",
    "/DStageDir=$Stage", "/DOutputDir=$Dist", "/DIconFile=$Icon",
    (Join-Path $Installer 'MIDIConverter.iss')
)
Assert-File $setupExe 'setup'

$sizeMB = [math]::Round((Get-Item -LiteralPath $setupExe).Length / 1MB, 1)
Write-Host ''
Write-Host "Setup: $setupExe ($sizeMB MB)" -ForegroundColor Green
