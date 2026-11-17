@echo off
title DJAchat - Conectar OneDrive
cd /d "%~dp0server"
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
"%NODE%" server.js --conectar-onedrive
pause
