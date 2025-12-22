import OpenAI from 'openai';
import { prisma } from '../../lib/db';
import { PipelineStage, ResearchData, BiographyFact } from '@content-pipeline/shared';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Perform research on a celebrity
 */
export async function performResearch(articleId: string): Promise<ResearchData> {
  const article = await prisma.article.findUnique({
    where: { id: articleId }
  });
  
  if (!article) {
    throw new Error('Article not found');
  }
  
  console.log(`Researching ${article.celebrityName}...`);
  
  // Create research prompt
  const prompt = createResearchPrompt(article.celebrityName);
  
  // Call OpenAI
  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo-preview',
    messages: [
      {
        role: 'system',
        content: `Ты эксперт-исследователь, специализирующийся на поиске КОНКРЕТНЫХ драматических фактов о знаменитостях для статей в стиле "Great Losers".

КРИТИЧЕСКИ ВАЖНО - ищи ТОЛЬКО:
✅ Конкретные неудачи с цифрами, датами, суммами
✅ Драматические низшие точки карьеры
✅ Скандалы, провалы, банкротства, зависимости
✅ Тюрьма, бедность, издевательства, травмы
✅ Отказы, увольнения, критика
✅ Контрасты: "был никем → стал звездой"

ОБЯЗАТЕЛЬНО указывай:
- Точный возраст в момент события
- Конкретные суммы денег
- Сколько дней/месяцев/лет длилось
- Имена людей, мест, компаний
- Цитаты героя (если есть)

❌ НЕ НУЖНЫ общие фразы типа "столкнулся с трудностями"
✅ НУЖНЫ детали типа "потерял $500,000", "провёл 113 дней в тюрьме"

Формат ответа: минимум 8-10 драматических фактов-неудач + итоговый успех с цифрами`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.7,
    max_tokens: 4000,
    response_format: { type: 'json_object' }
  });
  
  const researchData = JSON.parse(completion.choices[0].message.content || '{}');
  
  // Save to database
  await prisma.article.update({
    where: { id: articleId },
    data: {
      researchData,
      currentStage: PipelineStage.RESEARCH,
      updatedAt: new Date()
    }
  });
  
  return researchData;
}

function createResearchPrompt(celebrityName: string): string {
  return `
Исследуй жизнь ${celebrityName} и найди минимум 8-10 КОНКРЕТНЫХ драматических неудач/провалов.

ОБЯЗАТЕЛЬНЫЙ JSON формат:

{
  "failures": [
    {
      "number": 1,
      "title": "Краткий цепляющий заголовок с деталью",
      "age": "возраст когда это случилось",
      "year": "год события",
      "description": "Детальное описание со всеми цифрами, суммами, сроками",
      "outcome": "что из этого вышло",
      "severity": 1-5
    }
  ],
  "quotes": [
    {
      "text": "Точная цитата героя",
      "context": "Когда и почему он это сказал",
      "source": "Откуда цитата"
    }
  ],
  "success": {
    "peak_achievement": "Главное достижение с цифрами",
    "current_status": "Текущий статус",
    "wealth": "Состояние/гонорары с суммами",
    "awards": ["список наград"]
  },
  "bonus_fact": "Забавный или шокирующий малоизвестный факт",
  "timeline": "Краткая хронология: от [худшее] в [год] до [лучшее] в [год]",
  "sources": ["источник1", "источник2"]
}

КРИТИЧНО - каждая неудача должна содержать:
- Точный возраст или год
- Конкретные цифры (деньги, дни, километры, что угодно)
- Драматические детали
- Никаких общих фраз!

Примеры ХОРОШИХ заголовков:
✅ "В 17 лет работал живой статуей"
✅ "Провёл 113 дней в настоящей тюрьме"
✅ "Потерял дом и машину, оказался в долгах"

Примеры ПЛОХИХ заголовков:
❌ "Испытал финансовые трудности"
❌ "Столкнулся с проблемами"
❌ "Пережил сложный период"

Фокусируйся на:
- Зависимости, банкротства, тюрьма
- Отказы, увольнения, провальные проекты
- Травмы, болезни, потери близких
- Скандалы, судебные дела
- Бедность, долги, бездомность

История должна иметь хэппи-энд с конкретными цифрами успеха!
`;
}

