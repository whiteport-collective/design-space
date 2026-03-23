@echo off
REM Design Space — Agent Session Runner
REM Start this via Task Scheduler or manually
REM Set MACHINE_NAME in .env or override with --machine flag

cd /d %~dp0
node ds.js --auto-launch --machine %MACHINE_NAME%
