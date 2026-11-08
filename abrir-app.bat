@echo off
title DJAchat
cd /d "%~dp0desktop"
if not exist node_modules (
  echo Instalando o app pela primeira vez, aguarde...
  call npm install
)
call npm start
