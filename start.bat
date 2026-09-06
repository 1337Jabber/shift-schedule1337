@echo off
cd /d "%~dp0"
set "NODE=%USERPROFILE%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" server.js
pause