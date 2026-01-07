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
          ], // Focus on archival sources for TEXT search
          return_citations: true, // Get source URLs
          return_images: true, // Request images from Perplexity
          // Image filtering - get only quality historical photos
          image_domain_filter: [
            'wikimedia.org',
            'commons.wikimedia.org',
            'archive.org',
            'wikipedia.org',
            '-gettyimages.com',
            '-shutterstock.com',
            '-pinterest.com',
            '-istockphoto.com'
          ],
          image_format_filter: ['jpeg', 'png'], // Only jpeg and png, no webp
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
    
    // Check for images in the response (Perplexity returns them as objects with image_url, origin_url, etc.)
    const rawImages = data.images || [];
    // Extract direct image URLs from image objects (use image_url, not origin_url which is the article page)
    const perplexityImages: string[] = rawImages.map((img: any) => {
      if (typeof img === 'string') {
        return img;
      } else if (img && typeof img === 'object') {
        // Prefer image_url (direct image link), fallback to url/src
        return img.image_url || img.url || img.src || null;
      }
      return null;
    }).filter((url: string | null): url is string => !!url);
    
    console.log('📸 Perplexity returned images:', rawImages.length, '→ extracted URLs:', perplexityImages.length);
    if (perplexityImages.length > 0) {
      console.log('  Image URLs:', perplexityImages.slice(0, 5));
    }
    
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
    let researchData = convertToResearchData(rawData, citations, perplexityImages);
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
    
    // Debug: Log image status for each fact
    console.log('📊 Image URLs from Perplexity:');
    researchData.facts.forEach((f: BiographyFact, i: number) => {
      // Handle case where imageUrl might be an object (from Perplexity API)
      let imageUrlStr: string | undefined;
      if (typeof f.imageUrl === 'string') {
        imageUrlStr = f.imageUrl;
      } else if (f.imageUrl && typeof f.imageUrl === 'object') {
        // Perplexity returns image as object - use image_url (direct image), not origin_url (article page)
        const imgObj = f.imageUrl as any;
        imageUrlStr = imgObj.image_url || imgObj.url || imgObj.src || undefined;
        f.imageUrl = imageUrlStr; // Normalize to string
      }
      console.log(`  [${i + 1}] ${f.title}: ${imageUrlStr ? `✅ ${imageUrlStr.substring(0, 80)}...` : '❌ no URL'}`);
    });
    
    // Validate Perplexity image URLs - check if they are proper HTTP(S) URLs
    console.log('🔍 Validating Perplexity image URLs...');
    researchData.facts.forEach((f: BiographyFact, i: number) => {
      // Normalize imageUrl if it's an object - use image_url (direct image), not origin_url (article page)
      if (f.imageUrl && typeof f.imageUrl === 'object') {
        const imgObj = f.imageUrl as any;
        f.imageUrl = imgObj.image_url || imgObj.url || imgObj.src || undefined;
      }
      
      if (f.imageUrl && typeof f.imageUrl === 'string') {
        // Check if URL is valid HTTP(S) URL
        if (!f.imageUrl.match(/^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i)) {
          console.log(`  ❌ Invalid image URL for fact ${i + 1}: ${f.imageUrl}`);
          f.imageUrl = undefined; // Clear invalid URL to trigger Google fallback
        }
      } else {
        f.imageUrl = undefined; // Clear non-string values
      }
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
- 📸 ИЗОБРАЖЕНИЯ: ищи фотографии главного героя для каждого факта

📊 КАЧЕСТВО ИСТОЧНИКА (приоритет):
1. Автобиография героя, личные дневники
2. Архивные документы (газеты, суды, школы)
3. Мемуары близких людей
4. Видео/аудио интервью (с транскрипцией)
5. Биографические книги с исследованием
6. Документальные фильмы с архивными кадрами

🖼️ ВАЖНО ПРО ИЗОБРАЖЕНИЯ:
Обязательно ищи фотографии главного героя в разные периоды жизни.
Нам нужны изображения где виден сам человек, а не абстрактные места.`;
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
- 🖼️ ИЛЛЮСТРАЦИИ (КРИТИЧНО): для КАЖДОГО факта ОБЯЗАТЕЛЬНО найди изображение:
  * visual_suggestion: детальное описание что искать (всегда заполняй)
  * image_url: ПРЯМАЯ ссылка на .jpg/.png файл
  * ⭐ ОБЯЗАТЕЛЬНОЕ ПРАВИЛО: главный герой (${celebrityName}) ДОЛЖЕН БЫТЬ ИЗОБРАЖЕН на каждой картинке
  * В visual_suggestion описывай МОМЕНТ С ГЕРОЕМ: "фото ${celebrityName} в момент X", "кадр с ${celebrityName} во время Y"
  * НЕ используй: абстрактные места, предметы, события БЕЗ главного героя
  * Как искать image_url:
    - site:commons.wikimedia.org "${celebrityName}" "[событие]" filetype:jpg
    - site:upload.wikimedia.org "${celebrityName}" 
    - site:archive.org/download "${celebrityName}"
    - Проверь что URL заканчивается на .jpg, .jpeg или .png
    - Если не можешь найти URL - оставь пустым "", но visual_suggestion ОБЯЗАТЕЛЕН

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
      "visual_suggestion": "описание какое фото/документ искать",
      "image_url": "ПРЯМАЯ ссылка на .jpg/.png изображение для ЭТОГО факта (найди через поиск)"
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
  ],
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
