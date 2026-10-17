@echo off
REM Starts the bot AND the push-to-talk ears, each in its own window.
REM Before running: open your Minecraft world to LAN and put the port in .env as MC_PORT.
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing packages...
  call npm install
)
start "Buddy Ears (F8)" cmd /k "%~dp0start-ears.bat"
title Minecraft Buddy
npm start
pause
