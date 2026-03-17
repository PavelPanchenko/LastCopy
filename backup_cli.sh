#!/bin/bash

SERVER="root@91.223.77.160"
BASE_PATH="/var/www/tet-a-tet"

BACKUP_ROOT="./backups"
DATE=$(date +%F)
BACKUP_DIR="$BACKUP_ROOT/$DATE"

mkdir -p "$BACKUP_DIR"

echo "🔍 Получаем список сайтов..."

SITES=$(ssh $SERVER "ls $BASE_PATH")

echo ""
echo "📋 Найдено сайтов:"
echo "-------------------------"

i=1
declare -A SITE_MAP

for site in $SITES; do
    echo "$i) $site"
    SITE_MAP[$i]=$site
    ((i++))
done

echo ""
read -p "👉 Введи номера сайтов или 'all': " CHOICES

# если all → выбрать все
if [ "$CHOICES" = "all" ]; then
    CHOICES=$(seq 1 $((${#SITE_MAP[@]})))
fi

echo ""
echo "🚀 Начинаем бэкап..."
echo ""

for num in $CHOICES; do
    site=${SITE_MAP[$num]}
    SITE_PATH="$BASE_PATH/$site"

    echo "📦 Сайт: $site"

    TARGET_DIR="$BACKUP_DIR/$site"
    mkdir -p "$TARGET_DIR"

    # ===== ФАЙЛЫ (ИНКРЕМЕНТАЛЬНО) =====
    echo "  📁 Синхронизация (только изменения)..."

    rsync -az --delete \
      $SERVER:$SITE_PATH/ \
      "$TARGET_DIR/files/"

    # ===== БАЗА =====
    echo "  🗄 Бэкап БД..."

    CONFIG=$(ssh $SERVER "cat $SITE_PATH/wp-config.php 2>/dev/null || cat $SITE_PATH/.env 2>/dev/null")

    DB_NAME=$(echo "$CONFIG" | grep -E "DB_NAME|DB_DATABASE" | sed -E "s/.*['= ]([a-zA-Z0-9_]+).*/\1/")
    DB_USER=$(echo "$CONFIG" | grep -E "DB_USER|DB_USERNAME" | sed -E "s/.*['= ]([a-zA-Z0-9_]+).*/\1/")
    DB_PASS=$(echo "$CONFIG" | grep -E "DB_PASSWORD" | sed -E "s/.*['= ](.+).*/\1/")

    if [ -n "$DB_NAME" ]; then
        echo "  ✔ БД: $DB_NAME"

        ssh $SERVER "mysqldump -u$DB_USER -p$DB_PASS $DB_NAME" > "$TARGET_DIR/db.sql"
    else
        echo "  ⚠️ БД не найдена"
    fi

    echo ""
done

echo "✅ Бэкап завершён!"