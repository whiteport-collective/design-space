@echo off
REM The Conductor — Agent Session Manager
REM Start this via Task Scheduler or manually
REM Set MACHINE_NAME in .env or override with --machine flag

cd /d %~dp0
node conductor.js --auto-launch --machine %MACHINE_NAME%
