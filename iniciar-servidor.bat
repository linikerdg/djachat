@echo off
title DJAchat - Servidor
cd /d "%~dp0server"
REM Vazio = o servidor gera uma senha e mostra ao iniciar. Evite gravar uma senha aqui: este arquivo vai para o GitHub.
set "SENHA="
set "PORT=3000"
node server.js
pause
