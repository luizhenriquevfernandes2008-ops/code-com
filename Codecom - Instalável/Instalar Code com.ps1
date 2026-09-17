$ErrorActionPreference = "Stop"
$url = "https://desktop-tjk4u1q.tail02510a.ts.net"

$candidates = @(
    "$env:LOCALAPPDATA\Programs\Opera\opera.exe",
    "$env:LOCALAPPDATA\Programs\Opera GX\opera.exe",
    "$env:ProgramFiles\Opera\opera.exe",
    "${env:ProgramFiles(x86)}\Opera\opera.exe",
    "$env:ProgramFiles\Opera GX\opera.exe",
    "${env:ProgramFiles(x86)}\Opera GX\opera.exe"
)

$appPaths = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\opera.exe",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\opera.exe",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\opera.exe"
)
foreach ($registryPath in $appPaths) {
    if (Test-Path -LiteralPath $registryPath) {
        $registeredPath = (Get-Item -LiteralPath $registryPath).GetValue("")
        if ($registeredPath) { $candidates += $registeredPath }
    }
}

$opera = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $opera) {
    $command = Get-Command opera.exe -ErrorAction SilentlyContinue
    if ($command) { $opera = $command.Source }
}

if (-not $opera) {
    Write-Host "Nao encontrei o Opera instalado neste computador." -ForegroundColor Red
    Write-Host "Instale o Opera e execute este arquivo novamente."
    exit 1
}

$desktop = [Environment]::GetFolderPath("DesktopDirectory")
$shortcutPath = Join-Path $desktop "Code com.lnk"
$iconSource = Join-Path $PSScriptRoot "Code com.ico"
$iconDirectory = Join-Path $env:LOCALAPPDATA "Code com"
$iconPath = Join-Path $iconDirectory "Code com.ico"
if (Test-Path -LiteralPath $iconSource) {
    New-Item -ItemType Directory -Path $iconDirectory -Force | Out-Null
    Copy-Item -LiteralPath $iconSource -Destination $iconPath -Force
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $opera
$shortcut.Arguments = "`"$url`""
$shortcut.WorkingDirectory = Split-Path -Parent $opera
$shortcut.Description = "Abrir Code com no Opera"
$shortcut.IconLocation = if (Test-Path -LiteralPath $iconPath) { "$iconPath,0" } else { "$opera,0" }
$shortcut.Save()

Start-Process -FilePath $opera -ArgumentList "`"$url`""
Write-Host "Atalho criado na Area de Trabalho e o Code com foi aberto no Opera." -ForegroundColor Green
Write-Host "O notebook anfitriao precisa estar ligado com o servidor ativo."
