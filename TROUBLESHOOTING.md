# 🚨 Troubleshooting Guide

## Проблемы с установкой

### Error: esbuild installation failed (macOS)

Если вы получаете ошибку `dyld: Symbol not found: _SecTrustCopyCertificateChain`:

**Причина**: Несовместимость esbuild с вашей версией macOS.

**Решение**:

#### Вариант 1: Обновить macOS (рекомендуется)
```bash
# Обновитесь до macOS 12.0+ (Monterey или новее)
```

#### Вариант 2: Использовать Docker
```bash
# Создайте docker-compose.yml (см. ниже)
docker-compose up
```

#### Вариант 3: Установить через Rosetta (для Apple Silicon)
```bash
# Если у вас Apple Silicon (M1/M2/M3)
arch -x86_64 npm install
```

#### Вариант 4: Временный обход
```bash
# Удалите проблемные зависимости временно
cd packages/web
npm install --legacy-peer-deps

cd ../api  
npm install --legacy-peer-deps
```

### Error: PostgreSQL connection failed

```bash
# Проверьте статус
brew services list | grep postgresql

# Запустите PostgreSQL
brew services start postgresql@14

# Создайте базу данных
createdb content_pipeline
```

### Error: Redis connection failed

```bash
# Установите Redis (если не установлен)
brew install redis

# Запустите Redis
brew services start redis

# Проверьте
redis-cli ping
# Должно вернуть: PONG
```

## Docker Setup (Альтернативный вариант)

Создайте `docker-compose.yml` в корне проекта:

\`\`\`yaml
version: '3.8'

services:
  postgres:
    image: postgres:14-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: content_pipeline
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  api:
    build:
      context: .
      dockerfile: Dockerfile.api
    ports:
      - "3001:3001"
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/content_pipeline
      REDIS_HOST: redis
      REDIS_PORT: 6379
    depends_on:
      - postgres
      - redis
    volumes:
      - ./packages/api:/app
      - /app/node_modules

  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    ports:
      - "3000:3000"
    depends_on:
      - api
    volumes:
      - ./packages/web:/app
      - /app/node_modules

volumes:
  postgres_data:
  redis_data:
\`\`\`

Затем:

```bash
docker-compose up -d
```

## Минимальная установка без Docker

Если Docker не подходит, можно запустить упрощённую версию:

### 1. Использовать SQLite вместо PostgreSQL

Измените в `.env`:
```env
DATABASE_URL="file:./dev.db"
```

И в `packages/api/prisma/schema.prisma`:
```prisma
datasource db {
  provider = "sqlite"  // было: "postgresql"
  url      = env("DATABASE_URL")
}
```

### 2. Использовать in-memory очереди вместо Redis

Создайте `packages/api/src/services/queue-simple.ts`:
```typescript
// Простая in-memory реализация без Redis
const jobs = new Map();

export const researchQueue = {
  add: async (name, data) => {
    const id = Date.now().toString();
    jobs.set(id, { name, data, status: 'pending' });
    // Сразу выполняем
    setTimeout(() => processJob(id), 100);
    return { id };
  },
  getJobs: async () => Array.from(jobs.values())
};

async function processJob(id) {
  const job = jobs.get(id);
  // ... выполнение
}
```

## Поддерживаемые платформы

✅ **Полностью поддерживается**:
- macOS 12.0+ (Monterey)
- macOS 13.0+ (Ventura)
- macOS 14.0+ (Sonoma)
- Linux (Ubuntu 20.04+)
- Windows 10/11 (через WSL2)

⚠️ **Ограниченная поддержка**:
- macOS 11.0 (Big Sur) - требуются обходные пути
- macOS 10.15 (Catalina) - используйте Docker

## Контакты

Если проблемы не решены, создайте Issue на GitHub с:
- Версией macOS/Linux/Windows
- Версией Node.js (`node --version`)
- Полным текстом ошибки
- Логами из `/Users/legend/.npm/_logs/`
