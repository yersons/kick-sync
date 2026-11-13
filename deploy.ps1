<#
  Sube Kick Sync a un servidor Linux por SCP y reinicia el servicio.
  Nunca sube .env ni data\ (ahí viven tus claves y tus colas).

  Uso (PowerShell, dentro de la carpeta del proyecto):
    .\deploy.ps1 -Server usuario@mi-servidor
    .\deploy.ps1 -Server usuario@mi-servidor -Remote /opt/kick-sync -NoRestart
#>
param(
  [Parameter(Mandatory)][string]$Server,
  [string]$Remote = "/opt/kick-sync",
  [switch]$NoRestart
)
$ErrorActionPreference = "Stop"

function Invoke-Checked($description, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { throw "Falló: $description" }
}

Write-Host "==> Preparando carpetas en $Server" -ForegroundColor Cyan
Invoke-Checked "conectar por SSH" { ssh $Server "mkdir -p $Remote/data" }

Write-Host "==> Subiendo archivos" -ForegroundColor Cyan
$files = "server.js", "package.json", "README.md", ".env.example" | ForEach-Object { Join-Path $PSScriptRoot $_ }
Invoke-Checked "subir archivos" { scp @files "${Server}:$Remote/" }
foreach ($dir in "src", "public", "test", "deploy") {
  Invoke-Checked "subir $dir" { scp -r (Join-Path $PSScriptRoot $dir) "${Server}:$Remote/" }
}

if (-not $NoRestart) {
  Write-Host "==> Reiniciando el servicio" -ForegroundColor Cyan
  Invoke-Checked "reiniciar" { ssh $Server "systemctl restart kick-sync; sleep 2; systemctl is-active kick-sync; journalctl -u kick-sync -n 12 --no-pager" }
}
Write-Host "Listo." -ForegroundColor Green
