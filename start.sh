#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node &> /dev/null; then
  echo "Node.js не найден. Установите его: https://nodejs.org"
  echo "Нажмите Enter для выхода..."
  read
  exit 1
fi

echo "Установка зависимостей..."
npm install --production 2>/dev/null

echo "Запуск LastCopy..."
node server/index.js
