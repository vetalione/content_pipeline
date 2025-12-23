import { prisma } from '../../lib/db';
import { PipelineStage, ResearchData, BiographyFact } from '@content-pipeline/shared';

/**
 * Perform deep research using Perplexity AI with web search
 */
export async function performPerplexityResearch(articleId: string): Promise<ResearchData> {
  const article = await prisma.article.findUnique({
    where: { id: articleId }
  });
  
  if (!article) {
    throw new Error('Article not found');
  }
  
  console.log(`Deep research for ${article.celebrityName} using Perplexity...`);
  
  if (!process.env.PERPLEXITY_API_KEY) {
    throw new Error('PERPLEXITY_API_KEY not configured');
  }
  
  // Create detailed search prompt with Google Dorks and advanced search strategies
  const prompt = createDeepResearchPrompt(article.celebrityName);
  
  console.log('Calling Perplexity API with web search...');
  
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
          model: 'sonar-pro', // Most powerful model with citations
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
          temperature: 0.2, // Lower for factual accuracy
          max_tokens: 16000,
          search_domain_filter: [
            'archive.org',
            'books.google.com',
            'newspapers.com',
            'wikipedia.org',
            'britannica.com'
          ], // Focus on archival sources
          return_citations: true, // Get source URLs
          search_recency_filter: null // No recency filter for historical research
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
    
    // Convert to ResearchData format
    const researchData = convertToResearchData(rawData, citations);
    console.log('Converted research data with', researchData.facts.length, 'facts');
    
    // Save to database
    await prisma.article.update({
      where: { id: articleId },
      data: {
        researchData: researchData as any,
        currentStage: PipelineStage.RESEARCH,
        updatedAt: new Date()
      }
    });
    
    return researchData;
    
  } catch (error) {
    console.error('Perplexity research error:', error);
    throw new Error(`Research failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function getSystemPrompt(): string {
  return `Ты эксперт-исследователь, специализирующийся на глубоком архивном поиске РЕДКИХ драматических фактов о знаменитостях.

🎯 ЦЕЛЬ: Найти материал для статьи "[N] неудач [ИМЯ]" в стиле "Great Losers"

🔍 МЕТОДОЛОГИЯ ПОИСКА (КРИТИЧНО - используй ВСЕ источники):

1. **АРХИВНЫЕ ДОКУМЕНТЫ:**
   - Старые газетные вырезки (Google News Archive, archive.org/details/texts)
   - Сканы биографических книг (archive.org, Google Books)
   - Личные письма, дневники, записки из музеев
   - Судебные документы, протоколы (если публичные)
   - Школьные записи, дипломы, справки

2. **МЕМУАРЫ И АВТОБИОГРАФИИ:**
   - Книги героя (особенно малоизвестные издания)
   - Мемуары коллег, друзей, родственников
   - Неопубликованные черновики, рукописи
   - Предисловия и комментарии других знаменитостей

3. **ВИДЕО И АУДИО АРХИВЫ:**
   - Старые интервью на YouTube (транскрибируй через субтитры)
   - Архивы радио-эфиров (archive.org/details/audio)
   - Документальные фильмы и биографические передачи
   - Подкасты с упоминаниями героя
   - Лекции, выступления в университетах

4. **МАЛОИЗВЕСТНЫЕ ИЗДАНИЯ:**
   - Локальные газеты из родного города героя
   - Специализированные журналы (театральные, кинематографические, спортивные)
   - Студенческие газеты, школьные альманахи
   - Корпоративные бюллетени с первых мест работы

5. **GOOGLE DORKS (используй эти запросы):**
   - site:archive.org "[ИМЯ]" biography
   - site:newspapers.com "[ИМЯ]" childhood
   - "[ИМЯ]" filetype:pdf autobiography
   - "[ИМЯ]" "rare interview" OR "never published"
   - "[ИМЯ]" intext:"first job" OR "fired" OR "rejected"
   - "[ИМЯ]" site:*.edu (университетские архивы)
   - "[ИМЯ]" inurl:museum OR inurl:library

6. **РЕДКИЕ ФОТО:**
   - Детские фото из школьных альбомов
   - Фото с первых мест работы
   - Фото из газет до славы
   - Семейные архивы (если опубликованы)

🚫 ЧТО ИГНОРИРОВАТЬ:
- Wikipedia (слишком поверхностно)
- IMDB/официальные сайты (цензурированы)
- Новостные агрегаторы без первоисточника
- Статьи без конкретных цифр и дат

✅ ЧТО ИСКАТЬ:
- КОНКРЕТНЫЕ ЦИФРЫ: суммы, возраст, даты, сроки
- РЕДКИЕ детали: имена, места, обстоятельства
- ДРАМАТИЧЕСКИЕ МОМЕНТЫ: банкротство, тюрьма, зависимости, травмы
- ХРОНОЛОГИЯ: от детства (5-7 лет) к текущему моменту
- ПРЯМЫЕ ЦИТАТЫ героя из интервью/книг
- КОНТЕКСТ: что происходило вокруг, кто был свидетелем

📊 КАЧЕСТВО ИСТОЧНИКА (приоритет):
1. Автобиография героя, личные дневники
2. Архивные документы (газеты, суды, школы)
3. Мемуары близких людей
4. Видео/аудио интервью (с транскрипцией)
5. Биографические книги с исследованием
6. Документальные фильмы с архивными кадрами`;
}

function createDeepResearchPrompt(celebrityName: string): string {
  return `Проведи ГЛУБОКОЕ АРХИВНОЕ исследование жизни ${celebrityName}.

🔍 ОБЯЗАТЕЛЬНО используй:
- Google Dorks для поиска редких документов
- Архивы: archive.org, Google Books, newspapers.com
- YouTube транскрипты старых интервью (ищи субтитры)
- Автобиографические книги и мемуары
- Судебные документы (если есть публичный доступ)
- Газетные архивы из родного города
- Университетские библиотеки и музейные коллекции

🎯 Найди МИНИМУМ 10-12 КОНКРЕТНЫХ драматических неудач с:
- Точным возрастом или годом
- Конкретными суммами денег/сроками
- Именами людей, мест, компаний
- Первоисточником (книга стр. X, интервью дата Y, документ Z)

⚠️ ОСОБОЕ ВНИМАНИЕ:
- ДЕТСТВО: бедность, школа, первая работа (5-16 лет)
- ЮНОСТЬ: отказы, провалы, безденежье (17-25 лет)
- КАРЬЕРА: банкротства, увольнения, зависимости (25+ лет)
- РЕДКИЕ ФОТО: детские, школьные, с первых мест работы

📋 ОБЯЗАТЕЛЬНЫЙ JSON формат:

{
  "teaser": {
    "known_for": "Чем знаменит (3-4 топовых достижения с цифрами)",
    "hidden_drama": "Малоизвестная драматическая история из биографии",
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
      "severity": 1-5,
      "source": "конкретный источник: книга/статья/интервью с датой",
      "visual_suggestion": "какое фото/документ искать для иллюстрации"
    }
  ],
  "quotes": [
    {
      "text": "ТОЧНАЯ цитата героя (не пересказ!)",
      "context": "когда и почему сказал",
      "source": "название книги/интервью/передачи + дата",
      "page_or_timestamp": "страница или тайм-код",
      "suitable_for_ending": true/false
    }
  ],
  "success": {
    "peak_achievement": "главное достижение с цифрами",
    "current_status": "текущий статус на ${new Date().getFullYear()}",
    "wealth": "состояние/доход с конкретными суммами",
    "awards": ["награды с годами"],
    "personal_life": "семья, дети (если публично)"
  },
  "rare_sources": [
    {
      "type": "autobiography|memoir|interview|archive|document",
      "title": "название источника",
      "author": "автор",
      "year": "год публикации",
      "url": "ссылка если есть",
      "key_facts": "какие редкие факты оттуда"
    }
  ],
  "bonus_fact": "шокирующий малоизвестный факт с источником",
  "timeline": "краткая хронология: [худший момент, возраст] → [переломный момент] → [триумф]",
  "sources": ["все использованные источники с датами"]
}

🎯 КРИТЕРИИ КАЧЕСТВА:
- Каждая неудача имеет КОНКРЕТНЫЙ источник
- Все цитаты ТОЧНЫЕ (не пересказ)
- Минимум 3-4 источника НЕ из Wikipedia
- Хронология от детства (5-7 лет) к настоящему
- Редкие детали, о которых мало кто знает

⚠️ КРИТИЧНО: Выдавай СТРОГО ВАЛИДНЫЙ JSON:
- БЕЗ дублирующихся ключей
- БЕЗ trailing commas (запятая перед })
- Проверь синтаксис перед отправкой
- Только JSON, никакого текста до или после
- Используй двойные кавычки для строк

Выдавай только валидный JSON без дополнительного текста.`;
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
 */
function convertToResearchData(rawData: any, citations: string[]): ResearchData {
  const facts: BiographyFact[] = [];
  
  // Convert failures array to facts
  if (rawData.failures && Array.isArray(rawData.failures)) {
    rawData.failures.forEach((failure: any, index: number) => {
      facts.push({
        id: `fact-${index + 1}`,
        title: failure.title || `Неудача ${failure.number || index + 1}`,
        description: `${failure.description || ''}\n\n${failure.outcome || ''}`.trim(),
        category: 'failure',
        year: failure.year ? parseInt(failure.year) : undefined,
        severity: failure.severity || 3,
        sources: failure.source ? [failure.source] : []
      });
    });
  }
  
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
  
  return {
    facts,
    quotes,
    images: [], // Will be populated by cover generation
    sources: uniqueSources,
    generatedAt: new Date()
  };
}
