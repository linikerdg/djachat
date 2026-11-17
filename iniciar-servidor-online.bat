@echo off
title DJAchat - Servidor online
cd /d "%~dp0server"
REM Cria um endereco https publico pelo Cloudflare Tunnel. Os amigos nao precisam de VPN.
set "TUNEL=1"
set "SENHA="
set "PORT=3000"
REM usa o Node do PATH; se nao achar, o da pasta padrao de instalacao
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
"%NODE%" server.js
pause
