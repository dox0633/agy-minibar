# ==============================================================================
# enable-cdp.ps1 - Antigravity 调试端口一键配置 / 自愈脚本
#
# 功能: 为桌面、开始菜单、任务栏的 Antigravity 快捷方式追加 --remote-debugging-port=0 参数，
#       使客户端启动时自动开放 CDP 调试端口并写入 DevToolsActivePort，供 MiniBar 状态栏注入。
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts\enable-cdp.ps1         # 一键添加
#   powershell -ExecutionPolicy Bypass -File scripts\enable-cdp.ps1 -Undo   # 撤销改动
# ==============================================================================

param(
    [switch]$Undo,
    [string[]]$ShortcutDirectories = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('StartMenu'),
        [Environment]::GetFolderPath('CommonStartMenu'),
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
    )
)

$ErrorActionPreference = 'Stop'
$switchName = '--remote-debugging-port'
$switchText = "$switchName=0"
$switchPattern = "(^|\s)$([regex]::Escape($switchName))(=\S*)?(?=\s|$)"
$shell = New-Object -ComObject WScript.Shell

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Antigravity MiniBar - CDP 调试端口快捷方式配置工具" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$shortcuts = @(foreach ($dir in $ShortcutDirectories | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique) {
    foreach ($file in Get-ChildItem -LiteralPath $dir -Recurse -Filter *.lnk -ErrorAction SilentlyContinue) {
        try {
            $link = $shell.CreateShortcut($file.FullName)
            $targetPath = [string]$link.TargetPath
            $leaf = if ($targetPath) { Split-Path -Leaf $targetPath } else { '' }
            if ($leaf -match '^(Antigravity|Antigravity IDE)\.exe$') {
                [PSCustomObject]@{
                    Path      = $file.FullName
                    Link      = $link
                    HasSwitch = ([string]$link.Arguments -match $switchPattern)
                }
            }
        } catch {}
    }
})

if ($shortcuts.Count -eq 0) {
    Write-Host "[!] 未找到任何 Antigravity 快捷方式。" -ForegroundColor Yellow
    Write-Host "    若手动启动，请在命令行追加: Antigravity.exe $switchText" -ForegroundColor Gray
    exit 0
}

$updatedCount = 0

foreach ($sc in $shortcuts) {
    $argsStr = [string]$sc.Link.Arguments
    if ($Undo) {
        if (-not $sc.HasSwitch) {
            Write-Host "[-] 未带调试参数，无需改动: $($sc.Path)" -ForegroundColor Gray
            continue
        }
        $next = ($argsStr -replace $switchPattern, '').Trim()
    } else {
        if ($sc.HasSwitch) {
            Write-Host "[√] 已包含调试参数: $($sc.Path)" -ForegroundColor Green
            continue
        }
        $next = "$argsStr $switchText".Trim()
    }

    try {
        $sc.Link.Arguments = $next
        $sc.Link.Save()
        Write-Host "[+] 成功更新: $($sc.Path)" -ForegroundColor Cyan
        $updatedCount++
    } catch {
        Write-Host "[x] 写入失败 (可能需要管理员权限): $($sc.Path)" -ForegroundColor Red
    }
}

Write-Host "----------------------------------------------------------" -ForegroundColor Gray
if ($updatedCount -gt 0) {
    Write-Host "配置完成！已更新 $updatedCount 个快捷方式。" -ForegroundColor Green
    if (Get-Process -Name "Antigravity", "Antigravity IDE" -ErrorAction SilentlyContinue) {
        Write-Host "注意: 检测到 Antigravity 正在运行。请彻底退出应用（包括托盘）后重新启动生效！" -ForegroundColor Yellow
    }
} else {
    Write-Host "所有快捷方式已就绪，无需改动。" -ForegroundColor Green
}
