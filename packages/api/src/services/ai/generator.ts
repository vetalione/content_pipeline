import OpenAI from 'openai';
import { prisma } from '../../lib/db';
import { PipelineStage, ArticleContent, StyleConfig } from '@content-pipeline/shared';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Generate article content from research data
 */
export async function generateContent(
  articleId: string,
  styleConfig?: Partial<StyleConfig>
): Promise<ArticleContent> {
  const article = await prisma.article.findUnique({
    where: { id: articleId }
  });
  
  if (!article) {
    throw new Error('Article not found');
  }
  
  if (!article.researchData) {
    throw new Error('No research data available. Run research first.');
  }
  
  console.log(`Generating content for ${article.celebrityName}...`);
  
  const prompt = createGenerationPrompt(article.celebrityName, article.researchData, styleConfig);
  
  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo-preview',
    messages: [
      {
        role: 'system',
        content: `Ты профессиональный автор вирусных биографических статей в стиле канала "Great Losers" на Яндекс.Дзен.

СТРОГАЯ СТРУКТУРА СТАТЬИ:
- Заголовок: "[N] неудач [ИМЯ]" (где N = количество пунктов)
- Вступление: 2-3 предложения о контрасте "было плохо → стало отлично"
- Пронумерованные пункты неудач (каждый с подзаголовком)
- Секция "Итог:" или "Успех и признание:"
- Опционально "Бонусный факт:"
- Финальная мотивационная цитата в блоквоте

СТИЛЬ НАПИСАНИЯ:
✅ Разговорный русский язык, простые короткие предложения
✅ ОБЯЗАТЕЛЬНЫ конкретные детали: цифры, даты, суммы, возраст
✅ Драматизм через контрасты: "от [ужас] до [триумф]"
✅ Микс трагедии с легкой иронией
✅ Прямые цитаты героя в блокквотах (>) после каждых 2-3 пунктов
✅ Никаких абстракций - только факты и сюжет

СТРУКТУРА КАЖДОГО ПУНКТА:
1. ### [Номер]. [Цепляющий подзаголовок с деталью]
2. Абзац с описанием неудачи (3-5 предложений, конкретика!)
3. > Блокквот с цитатой или дополнительным шокирующим фактом

ФИНАЛ СТАТЬИ (обязательно):
"И помните: неудачи бывают у всех. А тем более у тех, кто действительно чего-то добивается. Главное не сдаваться. Это как раз то, что делает нас великими."

ПРИМЕРЫ ФОРМУЛИРОВОК:
❌ НЕ ПИШИ: "столкнулся с трудностями", "испытал разочарование"
✅ ПИШИ: "потерял дом и влез в долги на 50 000$", "провёл 113 дней в тюрьме"

❌ НЕ ПИШИ: "в детстве было непросто"
✅ ПИШИ: "в 7 лет попробовал наркотики, которые ему дал отец"

Генерируй JSON:
{
  "title": "[N] неудач [ИМЯ]",
  "subtitle": "От [конкретная низшая точка] до [конкретный триумф]",
  "sections": [
    {
      "number": 1,
      "heading": "Подзаголовок с деталью",
      "content": "Текст пункта",
      "quote": "Цитата или доп. факт"
    }
  ],
  "conclusion": {
    "heading": "Итог:",
    "content": "Описание успеха с цифрами",
    "finalQuote": "Мотивационная цитата"
  },
  "bonusFact": "Опциональный забавный факт"
}`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.8,
    max_tokens: 4000,
    response_format: { type: 'json_object' }
  });
  
  const content = JSON.parse(completion.choices[0].message.content || '{}');
  
  // Save to database
  await prisma.article.update({
    where: { id: articleId },
    data: {
      content,
      currentStage: PipelineStage.GENERATION,
      updatedAt: new Date()
    }
  });
  
  return content;
}

function createGenerationPrompt(
  celebrityName: string,
  researchData: any,
  styleConfig?: Partial<StyleConfig>
): string {
  const pointsCount = styleConfig?.pointsCount || 9;
  
  return `
Based on the following research about ${celebrityName}, create a compelling article in Russian.

Research data:
${JSON.stringify(researchData, null, 2)}

Return a JSON object with this structure:

{
  "title": "Цепляющий заголовок",
  "subtitle": "Подзаголовок",
  "intro": "Вступительный абзац (2-3 предложения)",
  "sections": [
    {
      "id": "section_1",
      "order": 1,
      "title": "Заголовок раздела",
      "content": "Полный текст раздела с деталями",
      "quote": {
        "text": "Цитата знаменитости",
        "context": "Контекст",
        "source": "Источник"
      },
      "memeText": "Врезка-мем или яркая фраза",
      "images": []
    }
  ],
  "conclusion": "Заключительный абзац",
  "motivation": "Мотивационная концовка о преодолении"
}

Requirements:
- Create exactly ${pointsCount} sections
- Each section covers one dramatic failure/struggle
- Order from worst failures to gradual success
- Include real quotes in sections
- Add meme-worthy captions (like "Когда думал что хуже не будет...")
- Write in engaging, slightly informal Russian
- Use эмоджи sparingly but effectively
- Final section should be about ultimate success
- Motivation should inspire despite hardships

Style: драматичный, вовлекающий, с элементами юмора, но уважительный к трагедиям.
`;
}
