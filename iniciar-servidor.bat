@echo off
title DJAchat - Servidor
cd /d "%~dp0server"
REM Vazio = o servidor gera uma senha e mostra ao iniciar. Evite gravar uma senha aqui: este arquivo vai para o GitHub.
set "SENHA="
set "PORT=3000"
REM usa o Node do PATH; se nao achar, o da pasta padrao de instalacao
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
"%NODE%" server.js
pause
