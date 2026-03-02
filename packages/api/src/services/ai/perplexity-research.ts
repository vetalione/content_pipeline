import { prisma } from '../../lib/db';
import { PipelineStage, ResearchData, BiographyFact } from '@content-pipeline/shared';
import { emitResearchProgress, emitResearchComplete, emitResearchError } from '../../lib/socket';
import { findFactImage } from '../media/google-images';

/**
 * Perform deep research using Perplexity AI with web search
 */
export async function performPerplexityResearch(
  articleId: string,
  mode: 'normal' | 'deep_dive' | 'restart' = 'normal'
): Promise<ResearchData> {
  const article = await prisma.article.findUnique({
    where: { id: articleId }
  });
  
  if (!article) {
    throw new Error('Article not found');
  }
  
  console.log(`Deep research for ${article.celebrityName} using Perplexity (mode: ${mode})...`);
  
  // Get existing facts for deep_dive mode
  let existingFactsCount = 0;
  if (mode === 'deep_dive' && article.researchData) {
    const researchData = article.researchData as any;
    existingFactsCount = researchData?.facts?.length || 0;
    console.log(`Deep dive mode: Found ${existingFactsCount} existing facts to extend`);
  }
  
  // Emit initial progress
  emitResearchProgress(articleId, {
    status: 'searching',
    currentFact: 0,
    totalFacts: mode === 'deep_dive' ? 20 : 12,
    percentage: 5,
    message: mode === 'deep_dive' 
      ? `Углубленное исследование: ищем дополнительные факты про ${article.celebrityName}`
      : `Начинаю глубокое исследование: ${article.celebrityName}`,
    startedAt: new Date().toISOString(),
  });
  
  if (!process.env.PERPLEXITY_API_KEY) {
    emitResearchError(articleId, 'PERPLEXITY_API_KEY not configured');
    throw new Error('PERPLEXITY_API_KEY not configured');
  }
  
  // Create detailed search prompt with Google Dorks and advanced search strategies
  const prompt = createDeepResearchPrompt(article.celebrityName);
  
  console.log('Calling Perplexity API with web search...');
  
  // Update progress
  emitResearchProgress(articleId, {
    status: 'searching',
    currentFact: 0,
    totalFacts: 12,
    percentage: 15,
    message: 'Поиск информации в архивах и исторических источниках...',
    startedAt: new Date().toISOString(),
  });
  
  let response: Response;
  
  try {
    response = await Promise.race([
      fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            {
              role: 'system',
              content: getSystemPrompt()
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.2,
          max_tokens: 16000,
          // NO search_domain_filter — previously we limited to 5 domains
          // (archive.org, books.google.com, newspapers.com, wikipedia.org, britannica.com)
          // which caused Perplexity to respond with a refusal ("I can only find basic
          // Wikipedia info, I can't fulfill your request") because the filter was
          // blocking 99% of the web. Let Perplexity search freely.
          return_citations: true,
          return_images: false
        })
      }),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Perplexity API timeout after 5 minutes')), 300000)
      )
    ]);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Perplexity API error: ${response.status} - ${errorText}`);
    }
    
    const data: any = await response.json();
    console.log('Perplexity response received:', JSON.stringify(data, null, 2));
    
    // NOTE: We intentionally ignore images from Perplexity
    // Images will be searched manually per fact using Google/Brave
    console.log('🚫 Ignoring images from Perplexity (will search manually)');
    
    // Update progress - parsing
    emitResearchProgress(articleId, {
      status: 'parsing',
      currentFact: 0,
      totalFacts: 12,
      percentage: 60,
      message: 'Обработка найденных данных...',
      startedAt: new Date().toISOString(),
    });
    
    const content = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];
    
    console.log('Citations found:', citations.length);
    
    // Parse JSON from response
    let rawData;
    try {
      rawData = extractJSON(content);
    } catch (parseError) {
      console.error('Failed to parse Perplexity JSON, using OpenAI to fix...');
      
      // Fallback: use OpenAI to convert messy text to clean JSON
      rawData = await fixJSONWithOpenAI(content, article.celebrityName);
    }
    
    // Convert to ResearchData format, passing Perplexity images
    let researchData = convertToResearchData(rawData, citations, []);
    console.log('Converted research data with', researchData.facts.length, 'facts');
    
    // In deep_dive mode, merge with existing facts
    if (mode === 'deep_dive' && article.researchData) {
      const existingData = article.researchData as any;
      const existingFacts = existingData.facts || [];
      
      // Merge facts, avoiding duplicates by title
      const existingTitles = new Set(existingFacts.map((f: BiographyFact) => f.title.toLowerCase()));
      const newFacts = researchData.facts.filter((f: BiographyFact) => !existingTitles.has(f.title.toLowerCase()));
      
      console.log(`Deep dive: Adding ${newFacts.length} new unique facts to existing ${existingFacts.length}`);
      
      researchData = {
        ...researchData,
        facts: [...existingFacts, ...newFacts],
        quotes: [...(existingData.quotes || []), ...researchData.quotes],
        sources: [...new Set([...(existingData.sources || []), ...researchData.sources])],
      };
    }
    
    // Update progress - completing
    emitResearchProgress(articleId, {
      status: 'completed',
      currentFact: researchData.facts.length,
      totalFacts: researchData.facts.length,
      percentage: 95,
      message: `Найдено ${researchData.facts.length} фактов`,
      startedAt: new Date().toISOString(),
    });
    
    // IMPORTANT: We ignore imageUrl from Perplexity completely
    // We only keep visualSuggestion, and images will be searched manually per fact
    console.log('🚫 Removing imageUrl from Perplexity (keeping only visualSuggestion)...');
    researchData.facts.forEach((f: BiographyFact, i: number) => {
      f.imageUrl = undefined; // Always clear - images will be searched on demand
      console.log(`  [${i + 1}] ${f.title}: visualSuggestion = "${f.visualSuggestion || 'none'}"`);
    });
    
    // NOTE: Image search is now done separately per fact via API
    // Facts are saved without images, user will click "find image" for each fact
    const factsWithoutImages = researchData.facts.filter((f: BiographyFact) => !f.imageUrl);
    console.log(`📋 Facts without images: ${factsWithoutImages.length}/${researchData.facts.length} (will be searched on demand)`);
    
    // Save to database
    await prisma.article.update({
      where: { id: articleId },
      data: {
        researchData: researchData as any,
        currentStage: PipelineStage.RESEARCH,
        updatedAt: new Date()
      }
    });
    
    // Emit complete
    emitResearchComplete(articleId, researchData);
    emitResearchProgress(articleId, {
      status: 'completed',
      currentFact: researchData.facts.length,
      totalFacts: researchData.facts.length,
      percentage: 100,
      message: 'Исследование завершено!',
      startedAt: new Date().toISOString(),
    });
    
    return researchData;
    
  } catch (error) {
    console.error('Perplexity research error:', error);
    emitResearchError(articleId, error instanceof Error ? error.message : 'Unknown error');
    throw new Error(`Research failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function getSystemPrompt(): string {
  return `Ты эксперт-биограф-исследователь. Твоя задача — найти материал для статьи в стиле "Неудачи [ИМЯ]" для русскоязычной аудитории на Прозе (Дзен).

ЦЕЛЬ: собрать откровенные, конкретные, драматические факты о провалах, бедности, унижениях и преодолениях на пути к славе.

ЧТО ИСКАТЬ (используй поиск по всему интернету):
• Факты из биографических книг и автобиографий (published, publicly available)
• Цитаты из интервью, подкастов, документальных фильмов
• Новостные статьи о скандалах, банкротствах, судебных делах
• Факты из ДЕТСТВА и ЮНОСТИ: бедность семьи, школа, первая работа, отказы
• Известные отказы: кто отказал, когда, что он ответил
• Зависимости, банкротства, судебные дела, тюрьма
• ПРЯМЫЕ ЦИТАТЫ героя из доступных источников

ЧТО НЕ ДЕЛАТЬ:
• НЕ отказывайся отвечать, ссылаясь на отсутствие архивных документов
• НЕ пиши вводные слова, отказы или объяснения — сразу JSON
• НЕ изобретай цитаты — если точной цитаты нет, оставь поле пустым
• НЕ дублируй факты и не пиши общие фразы без дат и цифр

ИСПОЛЬЗУЙ ЛЮБЫЕ ДОСТУПНЫЕ ИНТЕРНЕТ-ИСТОЧНИКИ:
• Биографические сайты и энциклопедии
• Новостные статьи и интервью с юмором
• YouTube транскрипты документальных фильмов и интервью
• Reddit, Quora — для оценок и цитат очевидцев
• Биографические подкасты с цитатами
• Исторические статьи из The Guardian, NYT, Rolling Stone, Variety и так далее

ОТВЕЧАЙ СРАЗУ JSON БЕЗ ЛЮБЫХ ВВОДНЫХ СЛОВ, ОТКАЗОВ, ОБЪЯСНЕНИЙ.`;
}

function createDeepResearchPrompt(celebrityName: string): string {
  return `Проведи детальное биографическое исследование жизни ${celebrityName}.

Найди 10-12 КОНКРЕТНЫХ драматических фактов — неудач, провалов, кризисов — в хронологическом порядке от детства к взрослому.

ХРОНОЛОГИЯ (строго от детства к взрослому):
1. Детство и семья (5-15 лет)
2. Школа, первые попытки (15-20 лет)
3. Отказы, провалы, борьба (20-30 лет)
4. Карьерные кризисы и скандалы (30+ лет)
5. Переломный момент и триумф

Каждый факт ОБЯЗАТЕЛЬНО содержит:
- Точный возраст или год
- Конкретные цифры (суммы, сроки, количество)
- Имена людей/мест/компаний
- Источник (статья/интервью/книга с датой)

ОСОБОЕ ВНИМАНИЕ на редкие, малоизвестные детали о:
- Бедности семьи, тяжёлом детстве
- Конкретных отказах (кто, когда, как ответил герой)
- Зависимостях, арестах, банкротствах
- Публичных провалах с реакцией критиков

ИЗОБРАЖЕНИЯ — для каждого факта заполни visual_suggestion:
- "фото ${celebrityName} [возраст/период] [контекст]"
- Герой ДОЛЖЕН быть виден на фото
- НЕ используй абстрактные описания без человека

ОБЯЗАТЕЛЬНЫЙ JSON формат (только JSON, никакого текста до или после):

{
  "teaser": {
    "known_for": "Чем знаменит (3-4 достижения с цифрами)",
    "hidden_drama": "Малоизвестная драматическая история",
    "childhood_photo_hint": "Описание редкого детского фото для поиска"
  },
  "failures": [
    {
      "number": 1,
      "title": "Краткий драматичный заголовок",
      "age": "точный возраст",
      "year": "точный год",
      "description": "ДЕТАЛЬНОЕ описание со всеми цифрами, именами, местами",
      "outcome": "что случилось дальше",
      "severity": 3,
      "source": "конкретный источник: книга/статья/интервью с датой",
      "visual_suggestion": "фото ${celebrityName} [ВОЗРАСТ/ПЕРИОД] [КОНТЕКСТ]"
    }
  ],
  "quotes": [
    {
      "text": "ТОЧНАЯ цитата героя (не пересказ)",
      "context": "когда и почему сказал",
      "source": "название книги/интервью/передачи + дата",
      "page_or_timestamp": "страница или тайм-код",
      "suitable_for_ending": true
    }
  ],
  "success": {
    "peak_achievement": "главное достижение с цифрами",
    "current_status": "текущий статус на ${new Date().getFullYear()} год",
    "wealth": "состояние/доход с конкретными суммами",
    "awards": ["награды с годами"],
    "personal_life": "семья, дети (если публично)"
  },
  "rare_sources": [
    {
      "type": "autobiography",
      "title": "название источника",
      "author": "автор",
      "year": "год",
      "url": "ссылка если есть",
      "key_facts": "какие редкие факты оттуда"
    }
  ],
  "bonus_fact": "шокирующий малоизвестный факт с источником",
  "timeline": "краткая хронология: [худшее, возраст] → [переломный момент] → [триумф]",
  "sources": ["все использованные источники с датами"]
}`;
}

/**
 * Extract JSON from response (handles markdown code blocks)
 */
function extractJSON(content: string): any {
  console.log('Raw content length:', content.length);
  
  // Remove markdown code blocks if present
  let jsonStr = content.trim();
  
  // Handle various markdown formats
  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr.replace(/^```json\s*\n?/, '').replace(/\n?```\s*$/, '');
  } else if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  
  // Try to find JSON object if wrapped in text
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }
  
  try {
    const parsed = JSON.parse(jsonStr);
    console.log('Successfully parsed JSON');
    return parsed;
  } catch (error) {
    console.error('JSON parse error:', error);
    console.error('Failed JSON string (first 1000 chars):', jsonStr.substring(0, 1000));
    
    // Try to fix common JSON errors
    try {
      // Remove trailing commas before closing braces/brackets
      let fixed = jsonStr
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
        // Fix duplicate keys by keeping only first occurrence
        .replace(/("[\w_]+"\s*:\s*[^,}]+),\s*\1/g, '$1');
      
      console.log('Attempting to parse fixed JSON...');
      const parsed = JSON.parse(fixed);
      console.log('Successfully parsed fixed JSON');
      return parsed;
    } catch (fixError) {
      console.error('Could not fix JSON:', fixError);
      throw new Error('Invalid JSON response from Perplexity');
    }
  }
}

/**
 * Fix broken JSON using OpenAI
 */
async function fixJSONWithOpenAI(brokenJSON: string, celebrityName: string): Promise<any> {
  console.log('Using OpenAI to fix malformed JSON...');
  
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured for JSON fixing');
  }
  
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: 'You are a JSON repair specialist. Extract research data from malformed JSON and return valid JSON matching the expected structure.'
      },
      {
        role: 'user',
        content: `Fix this broken JSON about ${celebrityName} and return valid JSON with structure:
{
  "teaser": {"known_for": "...", "hidden_drama": "...", "childhood_photo_hint": "..."},
  "failures": [{"number": 1, "title": "...", "age": "...", "year": "...", "description": "...", "outcome": "...", "severity": 1-5, "source": "...", "visual_suggestion": "..."}],
  "quotes": [{"text": "...", "context": "...", "source": "...", "page_or_timestamp": "...", "suitable_for_ending": true/false}],
  "success": {"peak_achievement": "...", "current_status": "...", "wealth": "...", "awards": [], "personal_life": "..."},
  "rare_sources": [{"type": "...", "title": "...", "author": "...", "year": "...", "url": "...", "key_facts": "..."}],
  "bonus_fact": "...",
  "timeline": "...",
  "sources": []
}

Broken JSON:
${brokenJSON.substring(0, 15000)}`
      }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1
  });
  
  const fixed = JSON.parse(completion.choices[0].message.content || '{}');
  console.log('OpenAI successfully fixed JSON');
  return fixed;
}

/**
 * Convert Perplexity format to ResearchData format
 * @param rawData Parsed JSON from Perplexity content
 * @param citations Citations array from Perplexity response
 * @param perplexityImages Images array from Perplexity response (separate field)
 */
function convertToResearchData(rawData: any, citations: string[], perplexityImages: string[] = []): ResearchData {
  const facts: BiographyFact[] = [];
  
  // Convert failures array to facts
  if (rawData.failures && Array.isArray(rawData.failures)) {
    rawData.failures.forEach((failure: any, index: number) => {
      // Try to get image from Perplexity images array (distribute across facts)
      const perplexityImageUrl = perplexityImages[index] || undefined;
      
      facts.push({
        id: `fact-${index + 1}`,
        title: failure.title || `Неудача ${failure.number || index + 1}`,
        description: `${failure.description || ''}\n\n${failure.outcome || ''}`.trim(),
        category: 'failure',
        year: failure.year ? parseInt(failure.year) : undefined,
        severity: failure.severity || 3,
        sources: failure.source ? [failure.source] : [],
        // Prefer Perplexity image, fallback to image_url from JSON
        imageUrl: perplexityImageUrl || failure.image_url || undefined,
        visualSuggestion: failure.visual_suggestion || undefined
      });
    });
  }
  
  console.log(`📸 Assigned ${perplexityImages.length} Perplexity images to ${facts.length} facts`);
  
  // Convert quotes array
  const quotes = (rawData.quotes || []).map((quote: any, index: number) => ({
    id: `quote-${index + 1}`,
    text: quote.text || '',
    context: quote.context || '',
    source: quote.source || 'Неизвестный источник',
    year: quote.year ? parseInt(quote.year) : undefined
  }));
  
  // Merge sources from raw data and citations
  const allSources = [
    ...(rawData.sources || []),
    ...citations
  ];
  
  // Deduplicate sources
  const uniqueSources = Array.from(new Set(allSources));
  
  // Images are now embedded in facts, not separate array
  // Keep images array empty (for compatibility with types)
  const images: any[] = [];
  
  return {
    facts,
    quotes,
    images, // Empty - images now in facts[].imageUrl
    sources: uniqueSources,
    generatedAt: new Date()
  };
}
