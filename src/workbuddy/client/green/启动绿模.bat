@echo off
chcp 65001 >nul
cd /d %~dp0
rem 无窗口启动:pythonw 跑 guardian,bat 立刻退出(窗口只闪一瞬间)
start "" pythonw.exe "%~dp0guardian.py"
exit
