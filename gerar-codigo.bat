@echo off
title DJAchat - Codigo para hospedar
cd /d "%~dp0server"
REM Mostra e copia o codigo para outro PC hospedar o DJAchat (precisa do OneDrive ja conectado aqui)
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
"%NODE%" server.js --gerar-codigo
pause
