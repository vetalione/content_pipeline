/**
 * Google Custom Search API for finding images
 * With Brave backup and optimized validation
 */

import { findBestImage } from './gemini-image-validator';
import { searchBraveImages } from './brave-images';
import { searchPerplexityImages } from './perplexity-images';

/**
 * Dictionary of known celebrity name translations (Russian → English)
 */
const CELEBRITY_TRANSLATIONS: Record<string, string> = {
  // Scientists
  'никола тесла': 'Nikola Tesla',
  'альберт эйнштейн': 'Albert Einstein',
  'мария кюри': 'Marie Curie',
  'стивен хокинг': 'Stephen Hawking',
  'исаак ньютон': 'Isaac Newton',
  'чарльз дарвин': 'Charles Darwin',
  'галилео галилей': 'Galileo Galilei',
  
  // Actors
  'роберт дауни младший': 'Robert Downey Jr',
  'роберт дауни мл': 'Robert Downey Jr',
  'уилл смит': 'Will Smith',
  'чарли чаплин': 'Charlie Chaplin',
  'чарльз чаплин': 'Charlie Chaplin',
  'леонардо дикаприо': 'Leonardo DiCaprio',
  'том хэнкс': 'Tom Hanks',
  'джонни депп': 'Johnny Depp',
  'брэд питт': 'Brad Pitt',
  'анджелина джоли': 'Angelina Jolie',
  'джим керри': 'Jim Carrey',
  'арнольд шварценеггер': 'Arnold Schwarzenegger',
  'сильвестр сталлоне': 'Sylvester Stallone',
  'мэрилин монро': 'Marilyn Monroe',
  'одри хепберн': 'Audrey Hepburn',
  'морган фриман': 'Morgan Freeman',
  'дензел вашингтон': 'Denzel Washington',
  'том круз': 'Tom Cruise',
  'мэл гибсон': 'Mel Gibson',
  
  // Musicians
  'элвис пресли': 'Elvis Presley',
  'майкл джексон': 'Michael Jackson',
  'фредди меркьюри': 'Freddie Mercury',
  'джон леннон': 'John Lennon',
  'пол маккартни': 'Paul McCartney',
  'мадонна': 'Madonna',
  'бритни спирс': 'Britney Spears',
  'эминем': 'Eminem',
  'леди гага': 'Lady Gaga',
  'бейонсе': 'Beyonce',
  'рианна': 'Rihanna',
  'тейлор свифт': 'Taylor Swift',
  
  // Business/Tech
  'стив джобс': 'Steve Jobs',
  'билл гейтс': 'Bill Gates',
  'илон маск': 'Elon Musk',
  'марк цукерберг': 'Mark Zuckerberg',
  'джефф безос': 'Jeff Bezos',
  'уоррен баффет': 'Warren Buffett',
  'генри форд': 'Henry Ford',
  'уолт дисней': 'Walt Disney',
  
  // Politicians/Leaders
  'авраам линкольн': 'Abraham Lincoln',
  'джон кеннеди': 'John F Kennedy',
  'барак обама': 'Barack Obama',
  'дональд трамп': 'Donald Trump',
  'уинстон черчилль': 'Winston Churchill',
  'нельсон мандела': 'Nelson Mandela',
  'махатма ганди': 'Mahatma Gandhi',
  
  // Athletes
  'мухаммед али': 'Muhammad Ali',
  'майкл джордан': 'Michael Jordan',
  'криштиану роналду': 'Cristiano Ronaldo',
  'лионель месси': 'Lionel Messi',
  'тайгер вудс': 'Tiger Woods',
  'усейн болт': 'Usain Bolt',
  
  // Writers/Artists
  'лев толстой': 'Leo Tolstoy',
  'фёдор достоевский': 'Fyodor Dostoevsky',
  'антон чехов': 'Anton Chekhov',
  'александр пушкин': 'Alexander Pushkin',
  'пабло пикассо': 'Pablo Picasso',
  'винсент ван гог': 'Vincent van Gogh',
  'леонардо да винчи': 'Leonardo da Vinci',
  'микеланджело': 'Michelangelo',
  
  // TV
  'опра уинфри': 'Oprah Winfrey',
  'эллен дедженерес': 'Ellen DeGeneres',
  
  // Inventors
  'братья райт': 'Wright Brothers',
  'томас эдисон': 'Thomas Edison',
  'александр белл': 'Alexander Graham Bell',
};

/**
 * Translate celebrity name from Russian to English
 * Uses dictionary first, then falls back to transliteration
 */
function translateCelebrityName(name: string): string {
  const lowerName = name.toLowerCase().trim();
  
  // Check dictionary first
  if (CELEBRITY_TRANSLATIONS[lowerName]) {
    return CELEBRITY_TRANSLATIONS[lowerName];
  }
  
  // Check partial matches (for variations like "Николы Теслы")
  for (const [ru, en] of Object.entries(CELEBRITY_TRANSLATIONS)) {
    // Check if the input contains the key name (for genitive case etc)
    const ruWords = ru.split(' ');
    const nameWords = lowerName.split(' ');
    
    // Match if first word starts similarly (handles Russian declensions)
    if (ruWords[0] && nameWords[0] && 
        (nameWords[0].startsWith(ruWords[0].substring(0, 4)) || 
         ruWords[0].startsWith(nameWords[0].substring(0, 4)))) {
      return en;
    }
  }
  
  // Fallback to transliteration
  return transliterate(name);
}

/**
 * Translate Russian name/text to English for better Google search results
 */
function transliterate(text: string): string {
  const map: Record<string, string> = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo',
    'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M',
    'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U',
    'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Shch',
    'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya'
  };
  return text.split('').map(char => map[char] || char).join('');
}

interface GoogleImageResult {
  link: string;
  title: string;
  snippet: string;
  mime: string;
  image: {
    contextLink: string;
    height: number;
    width: number;
    thumbnailLink: string;
  };
}

interface GoogleSearchResponse {
  items?: GoogleImageResult[];
  searchInformation?: {
    totalResults: string;
  };
}

/**
 * Search for images using Google Custom Search API
 * @param query Search query (e.g., "Leo Tolstoy childhood photo 1850")
 * @param numResults Number of results to return (max 10 per request)
 * @returns Array of direct image URLs
 */
export async function searchGoogleImages(
  query: string,
  numResults: number = 3
): Promise<string[]> {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;

  if (!apiKey || !cx) {
    console.warn('⚠️ Google Custom Search not configured (GOOGLE_API_KEY or GOOGLE_CX missing)');
    return [];
  }

  try {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', query);
    url.searchParams.set('searchType', 'image');
    url.searchParams.set('num', String(Math.min(numResults, 10)));
    url.searchParams.set('safe', 'off');
    url.searchParams.set('imgSize', 'large');
    url.searchParams.set('fileType', 'jpg,png');

    console.log(`🔍 Google Image Search: "${query}"`);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Google Search API error: ${response.status} - ${errorText}`);
      return [];
    }

    const data = await response.json() as GoogleSearchResponse;

    if (!data.items || data.items.length === 0) {
      console.log(`No images found for: "${query}"`);
      return [];
    }

    const imageUrls = data.items
      .map(item => item.link)
      .filter(url => {
        // Only allow direct image URLs
        const lower = url.toLowerCase();
        return lower.endsWith('.jpg') || 
               lower.endsWith('.jpeg') || 
               lower.endsWith('.png') ||
               lower.includes('.jpg?') ||
               lower.includes('.jpeg?') ||
               lower.includes('.png?');
      });

    console.log(`✅ Found ${imageUrls.length} images for: "${query}"`);
    return imageUrls;

  } catch (error) {
    console.error('Google Image Search error:', error);
    return [];
  }
}

/**
 * Extract key search terms from visual suggestion
 * Removes overly specific details that hurt Google search
 */
function extractKeywords(visualSuggestion: string, celebrityName: string): string {
  // Remove the celebrity name from suggestion (we add it separately)
  let cleaned = visualSuggestion
    .replace(new RegExp(celebrityName, 'gi'), '')
    .replace(/редкое фото/gi, '')
    .replace(/фото/gi, '')
    .replace(/photo/gi, '')
    .replace(/[«»""]/g, '')
    .trim();
  
  const keywords: string[] = [];
  
  // Look for age mentions: "5-10 лет", "около 20 лет", "в 15 лет"
  const ageMatch = cleaned.match(/(\d+[-–—]\d+|\d+)\s*(лет|год|years?\s*old)/i);
  if (ageMatch) {
    const ageNum = ageMatch[1].includes('-') ? ageMatch[1].split(/[-–—]/)[0] : ageMatch[1];
    keywords.push(`${ageNum} years old`);
  }
  
  // Look for year
  const yearMatch = cleaned.match(/\b(18|19|20)\d{2}\b/);
  if (yearMatch) keywords.push(yearMatch[0]);
  
  // Key context words - extract and translate
  const contextTranslations: Record<string, string> = {
    'детство': 'childhood', 'детский': 'childhood', 'маленький': 'young child',
    'молодой': 'young', 'юность': 'young', 'юный': 'young',
    'школа': 'school', 'университет': 'university', 'колледж': 'college',
    'ферма': 'farm', 'дом': 'home', 'семья': 'family',
    'студия': 'studio', 'офис': 'office', 'работа': 'work',
    'сцена': 'stage', 'концерт': 'concert', 'выступление': 'performance',
    'свадьба': 'wedding', 'жена': 'wife', 'муж': 'husband',
    'тюрьма': 'prison', 'суд': 'court', 'арест': 'arrest',
    'война': 'war', 'армия': 'army', 'военный': 'military',
    'награда': 'award', 'оскар': 'oscar', 'премия': 'award',
    'портрет': 'portrait', 'студийный': 'studio portrait',
    'чёрно-белое': 'black and white', 'черно-белое': 'black and white',
    'интервью': 'interview', 'пресс': 'press',
    'ранний': 'early', 'первый': 'first', 'начало': 'early',
    'банкротство': 'bankruptcy', 'провал': 'failure',
  };
  
  // Find matching Russian words and translate
  const cleanedLower = cleaned.toLowerCase();
  for (const [ru, en] of Object.entries(contextTranslations)) {
    if (cleanedLower.includes(ru)) {
      keywords.push(en);
      // Stop after finding 2-3 context words
      if (keywords.length >= 4) break;
    }
  }
  
  // If still no good keywords, extract year decade as fallback
  if (keywords.length === 0 && yearMatch) {
    const year = parseInt(yearMatch[0]);
    const decade = Math.floor(year / 10) * 10;
    keywords.push(`${decade}s`);
  }
  
  // Default fallback
  if (keywords.length === 0) {
    keywords.push('vintage photo');
  }
  
  return keywords.join(' ');
}

/**
 * Check if celebrity name is already in English (Latin characters)
 */
function isEnglishName(name: string): boolean {
  // If more than 50% of letters are Latin, consider it English
  const latinLetters = name.match(/[a-zA-Z]/g) || [];
  const allLetters = name.match(/[a-zA-Zа-яА-ЯёЁ]/g) || [];
  return allLetters.length > 0 && latinLetters.length / allLetters.length > 0.5;
}

export interface ImageSearchOptions {
  useGoogle?: boolean;
  useBrave?: boolean;
  usePerplexity?: boolean;
  confidenceThreshold?: number;
  resultsPerSource?: number;
}

/**
 * Find image for a specific biography fact
 * Constructs search query from fact details and validates with Gemini
 * Uses Google as primary source, Brave as backup
 */
export async function findFactImage(
  celebrityName: string,
  factTitle: string,
  factYear?: number,
  visualSuggestion?: string,
  onProgress?: (progress: { stage: string; current: number; total: number; confidence?: number }) => void,
  options?: ImageSearchOptions
): Promise<string | null> {
  // Default options
  const {
    useGoogle = true,
    useBrave = true,
    usePerplexity = true,
    confidenceThreshold = 85,
    resultsPerSource = 5
  } = options || {};
  
  // Always translate to English using dictionary + transliteration
  const englishName = translateCelebrityName(celebrityName);
  const nameIsEnglish = isEnglishName(celebrityName);
  
  console.log(`  👤 Name: "${celebrityName}" → "${englishName}"`);
  
  // Extract keywords from visual suggestion
  let keywords = '';
  if (visualSuggestion) {
    keywords = extractKeywords(visualSuggestion, celebrityName);
  }
  
  // ===== PRIMARY QUERY (English - wider coverage) =====
  const enQueryParts = [englishName, 'photo'];
  
  if (keywords) {
    enQueryParts.push(keywords);
  }
  
  if (factYear) {
    enQueryParts.push(String(factYear));
  }

  const enQuery = enQueryParts.join(' ');
  console.log(`  🔎 English query: "${enQuery}"`);
  
  // ===== SECONDARY QUERY (Russian - for Russian celebrities) =====
  let ruQuery = '';
  if (!nameIsEnglish) {
    const ruQueryParts = [celebrityName, 'фото'];
    
    // For Russian query, use simpler keywords
    if (factYear) {
      ruQueryParts.push(String(factYear));
    }
    
    // Add year decade context
    if (factYear && factYear < 2000) {
      ruQueryParts.push('архив');
    }
    
    ruQuery = ruQueryParts.join(' ');
    console.log(`  🔎 Russian query: "${ruQuery}"`);
  }
  
  // ===== SEARCH PHASE: Parallel Google + Brave =====
  // Search both sources in parallel for better coverage and rare images
  interface ImageCandidate {
    url: string;
    source: 'google-en' | 'google-ru' | 'brave' | 'perplexity';
  }
  
  let allCandidates: ImageCandidate[] = [];
  
  console.log(`  🔍 Searching: Google=${useGoogle}, Brave=${useBrave}, Perplexity=${usePerplexity}, resultsPerSource=${resultsPerSource}`);
  
  // Build search description for Perplexity (more context-aware)
  const searchDescription = visualSuggestion || `${englishName} ${factTitle}`;
  
  // Parallel search: all enabled sources
  const searches: Promise<string[]>[] = [];
  const sources: Array<'google-en' | 'google-ru' | 'brave' | 'perplexity'> = [];
  
  if (useGoogle) {
    searches.push(searchGoogleImages(enQuery, resultsPerSource));
    sources.push('google-en');
    
    // Add Russian query for Russian celebrities
    if (ruQuery) {
      searches.push(searchGoogleImages(ruQuery, Math.max(3, Math.floor(resultsPerSource * 0.8))));
      sources.push('google-ru');
    }
  }
  
  if (useBrave) {
    searches.push(searchBraveImages(enQuery, resultsPerSource));
    sources.push('brave');
  }
  
  if (usePerplexity) {
    searches.push(searchPerplexityImages(searchDescription, resultsPerSource));
    sources.push('perplexity');
  }
  
  if (searches.length === 0) {
    console.log(`  ⚠️ No search engines enabled`);
    return null;
  }
  
  const results = await Promise.all(searches);
  let sourceIndex = 0;
  results.forEach(urls => {
    const source = sources[sourceIndex++];
    console.log(`  📊 ${source}: ${urls.length} results`);
    allCandidates.push(...urls.map(url => ({ url, source })));
  });
  
  // Remove duplicates by URL, keeping first occurrence (preserves source)
  const seen = new Set<string>();
  const uniqueCandidates = allCandidates.filter(candidate => {
    if (seen.has(candidate.url)) {
      return false;
    }
    seen.add(candidate.url);
    return true;
  });
  
  console.log(`  📷 Total unique candidates: ${uniqueCandidates.length}`);
  
  // Log source distribution
  const sourceStats = uniqueCandidates.reduce((acc, c) => {
    acc[c.source] = (acc[c.source] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`  📊 Source distribution:`, sourceStats);
  
  if (uniqueCandidates.length === 0) {
    return null;
  }

  // Use Gemini to validate with early-exit optimization
  const description = visualSuggestion || factTitle;
  
  try {
    console.log(`  🔍 Starting optimized validation (early-exit at ${confidenceThreshold}% confidence)...`);
    
    // Report search complete, starting validation
    if (onProgress) {
      onProgress({ stage: 'validating', current: 0, total: uniqueCandidates.length });
    }
    
    const bestImage = await findBestImage(
      uniqueCandidates.map(c => c.url), 
      celebrityName, 
      description, 
      onProgress,
      uniqueCandidates.map(c => c.source),
      confidenceThreshold
    );
    return bestImage;
  } catch (error) {
    console.error(`  ❌ Image validation error:`, error);
    // On error, return first candidate as fallback
    if (uniqueCandidates.length > 0) {
      console.log(`  🔄 Error fallback: using first candidate from ${uniqueCandidates[0].source}`);
      return uniqueCandidates[0].url;
    }
    return null;
  }
}
