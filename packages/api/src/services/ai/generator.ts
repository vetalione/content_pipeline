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
        content: `You are a professional content writer specializing in viral biography articles. Your style:
- Dramatic and engaging storytelling
- Mix of tragedy and inspiration
- Conversational Russian language
- Uses memes and pop culture references
- Structured with clear sections
- Includes memorable quotes
- Ends with motivation and success story`
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
