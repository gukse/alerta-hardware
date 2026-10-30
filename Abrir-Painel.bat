@echo off
cd /d "%~dp0"
echo Iniciando Painel Configurador do Bot em http://localhost:3333 ...
start "" "http://localhost:3333"
node painel.js
pause
