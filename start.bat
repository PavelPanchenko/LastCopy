@echo off
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js не найден. Установите его: https://nodejs.org
    pause
    exit /b 1
)

echo Установка зависимостей...
call npm install --production 2>nul

echo Запуск LastCopy...
node server/index.js
pause
