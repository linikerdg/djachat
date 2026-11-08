@echo off
title DJAchat - Servidor online
cd /d "%~dp0server"
REM Cria um endereco https publico pelo Cloudflare Tunnel. Os amigos nao precisam de VPN.
set "TUNEL=1"
set "SENHA="
set "PORT=3000"
"C:\Program Files\nodejs\node.exe" server.js
pause
