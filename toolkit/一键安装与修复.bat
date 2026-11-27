@echo off
chcp 65001 >nul
setlocal
title Antigravity MiniBar 一站式安装与修复

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js ^>= 22.5 后重试。
  pause
  exit /b 1
)

echo ============================================================
echo   Antigravity MiniBar 一站式安装与升级修复工具
echo   包含：MiniBar插件 / 全局规则 / 界面汉化 / 4档增强与中文标题
echo ============================================================
echo.
echo   [1] 一键安装 / 升级后全量修复 (推荐)
echo   [2] 仅查看当前状态
echo   [3] 仅修复界面汉化与内核增强 (升级后常用)
echo   [4] 还原客户端英文界面与 0 档原版内核
echo   [0] 退出
echo.
set /p CHOICE=请输入选项 [默认 1]: 
if "%CHOICE%"=="" set CHOICE=1

if "%CHOICE%"=="1" (
  node "%~dp0setup.mjs" --all
) else if "%CHOICE%"=="2" (
  node "%~dp0setup.mjs" --status
) else if "%CHOICE%"=="3" (
  node "%~dp0setup.mjs" --i18n --enhance
) else if "%CHOICE%"=="4" (
  node "%~dp0setup.mjs" --restore
) else if "%CHOICE%"=="0" (
  exit /b 0
) else (
  echo [提示] 无效选项，退出。
  pause
  exit /b 1
)

echo.
pause
