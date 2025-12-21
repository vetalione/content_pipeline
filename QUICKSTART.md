# 🚀 Quick Start Guide (Упрощённый запуск)

## Быстрый старт без Docker

Если у вас проблемы с установкой полной версии, используйте этот упрощённый вариант.

### Шаг 1: Проверка версии macOS

```bash
sw_vers
```

Если версия < 12.0 (Monterey), продолжайте с упрощённой установкой.

### Шаг 2: Установка только backend

```bash
cd packages/api
npm install --legacy-peer-deps
```

### Шаг 3: Использование SQLite

В `.env` измените:
```env
DATABASE_URL="file:./dev.db"
```

В `packages/api/prisma/schema.prisma`:
```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

### Шаг 4: Запуск без Redis (опционально)

Закомментируйте BullMQ в `packages/api/src/services/queue.ts`:

```typescript
// Временно отключаем очереди
export const researchQueue = {
  add: async (name: string, data: any) => {
    console.log('Job queued:', name, data);
    // TODO: выполнить синхронно
  },
  getJobs: async () => []
};
```

### Шаг 5: Запуск API

```bash
cd packages/api
npm run dev
```

### Шаг 6: Тестирование API

```bash
# Создать статью
curl -X POST http://localhost:3001/api/articles \
  -H "Content-Type: application/json" \
  -d '{"celebrityName": "Илон Маск"}'

# Получить список статей
curl http://localhost:3001/api/articles
```

## Альтернатива: Развёртывание в облаке

### Railway.app (рекомендуется для новичков)

1. Зарегистрируйтесь на https://railway.app
2. Нажмите "New Project" → "Deploy from GitHub repo"
3. Railway автоматически:
   - Установит PostgreSQL
   - Установит Redis
   - Развернёт API
   - Настроит переменные окружения

### Vercel (для frontend)

```bash
cd packages/web
vercel
```

### Render.com (для backend)

1. Зарегистрируйтесь на https://render.com
2. Создайте новый Web Service
3. Подключите GitHub репозиторий
4. Render автоматически развернёт проект

## Что делать дальше?

После успешного запуска:

1. **Получите OpenAI API ключ** - https://platform.openai.com/api-keys
2. **Настройте Telegram бота** - @BotFather
3. **Создайте первую статью** через API:

```bash
# 1. Создать статью
ARTICLE_ID=$(curl -s -X POST http://localhost:3001/api/articles \
  -H "Content-Type: application/json" \
  -d '{"celebrityName": "Стив Джобс"}' | jq -r '.data.id')

# 2. Запустить исследование
curl -X POST http://localhost:3001/api/pipeline/$ARTICLE_ID/research

# 3. Проверить статус
curl http://localhost:3001/api/articles/$ARTICLE_ID
```

## Минимальные требования

- Node.js 18+
- 2GB RAM
- macOS 10.15+ / Linux / Windows 10+

## Помощь

Не получается? Напишите:
- GitHub Issues
- Telegram: @yourusername
- Email: support@yourproject.com
