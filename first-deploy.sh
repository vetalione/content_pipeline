#!/bin/bash

# 🚀 Скрипт первого деплоя на Railway

echo "🎯 Content Pipeline - Первый деплой"
echo "====================================="
echo ""

# Проверка что мы в правильной директории
if [ ! -f "railway.json" ]; then
    echo "❌ Ошибка: railway.json не найден"
    echo "Запустите скрипт из корня проекта content-pipeline"
    exit 1
fi

echo "✅ railway.json найден"
echo ""

# Проверка git
if [ ! -d ".git" ]; then
    echo "📦 Инициализация git репозитория..."
    git init
    echo "✅ Git репозиторий создан"
else
    echo "✅ Git репозиторий уже существует"
fi

echo ""
echo "📝 Добавление файлов в git..."
git add .

echo ""
echo "💬 Создание коммита..."
git commit -m "Initial commit: Content Pipeline for Railway deployment

- Monorepo setup with packages/web, packages/api, packages/shared
- Express API with TypeScript
- React frontend with Vite
- Prisma schema for PostgreSQL
- BullMQ job queues
- AI integration (OpenAI/Claude/Gemini)
- Playwright automation for social media publishing
- Railway deployment configuration (railway.json, nixpacks.toml)
- Multi-language support (RU/EN/BOTH)
- Platform mapping based on language"

echo ""
echo "✅ Коммит создан"
echo ""

echo "📌 Следующие шаги:"
echo ""
echo "1. Создайте новый репозиторий на GitHub:"
echo "   https://github.com/new"
echo ""
echo "2. Скопируйте URL репозитория (например: https://github.com/username/content-pipeline.git)"
echo ""
echo "3. Выполните команды:"
echo "   git remote add origin https://github.com/ВАШ_USERNAME/content-pipeline.git"
echo "   git branch -M main"
echo "   git push -u origin main"
echo ""
echo "4. Зайдите на Railway.app и подключите ваш GitHub репозиторий"
echo ""
echo "5. Следуйте инструкциям в RAILWAY_DEPLOYMENT.md"
echo ""
echo "🎉 Готово! Код подготовлен для деплоя."
