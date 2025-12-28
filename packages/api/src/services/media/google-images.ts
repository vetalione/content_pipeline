/**
 * Google Custom Search API for finding images
 */

import { findBestImage } from './gemini-image-validator';

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

/**
 * Translate Russian keywords to English for search
 */
function translateKeywordsToEnglish(keywords: string): string {
  const translations: Record<string, string> = {
    'школа': 'school', 'университет': 'university', 'суд': 'court',
    'концерт': 'concert', 'сцена': 'stage', 'студия': 'studio',
    'тюрьма': 'prison', 'детство': 'childhood', 'юность': 'youth',
    'свадьба': 'wedding', 'развод': 'divorce', 'арест': 'arrest',
    'интервью': 'interview', 'фото': 'photo', 'год': 'year', 'лет': 'years old',
    'молодой': 'young', 'старый': 'old', 'первый': 'first', 'последний': 'last',
    'начало': 'beginning', 'карьера': 'career', 'работа': 'work', 'семья': 'family',
    'дом': 'home', 'родители': 'parents', 'дети': 'children', 'жена': 'wife',
    'муж': 'husband', 'рождение': 'birth', 'смерть': 'death'
  };
  
  let result = keywords.toLowerCase();
  for (const [ru, en] of Object.entries(translations)) {
    result = result.replace(new RegExp(ru, 'gi'), en);
  }
  return result;
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
  let cleaned = visualSuggestion.replace(new RegExp(celebrityName, 'gi'), '');
  
  // Extract key phrases (keep only important nouns and context)
  // Remove: detailed descriptions, emotions, clothing details
  
  // Take first sentence or clause (before colon or comma)
  const firstPart = cleaned.split(/[,:]/)[0];
  
  // Extract key nouns (age, event, location)
  const keywords: string[] = [];
  
  // Look for age mentions
  const ageMatch = firstPart.match(/(\d+[-–—]\d+|^\d+)\s*(лет|год)/i);
  if (ageMatch) keywords.push(ageMatch[0]);
  
  // Look for key event words
  const eventWords = ['школа', 'университет', 'суд', 'концерт', 'сцена', 'студия', 'тюрьма', 
                      'детство', 'юность', 'свадьба', 'развод', 'арест', 'интервью'];
  eventWords.forEach(word => {
    if (firstPart.toLowerCase().includes(word)) {
      keywords.push(word);
    }
  });
  
  // Look for year
  const yearMatch = firstPart.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) keywords.push(yearMatch[0]);
  
  // If no keywords found, take first 3-5 significant words
  if (keywords.length === 0) {
    const words = firstPart.split(/\s+/).filter(w => w.length > 3);
    keywords.push(...words.slice(0, 4));
  }
  
  return keywords.join(' ');
}

/**
 * Find image for a specific biography fact
 * Constructs search query from fact details and validates with Gemini
 */
export async function findFactImage(
  celebrityName: string,
  factTitle: string,
  factYear?: number,
  visualSuggestion?: string
): Promise<string | null> {
  // Transliterate celebrity name to English for better international search
  const englishName = transliterate(celebrityName);
  
  // Build search query in ENGLISH for wider coverage
  const queryParts = [englishName, 'photo'];
  
  if (visualSuggestion) {
    // Extract only key search terms, not full description
    const keywords = extractKeywords(visualSuggestion, celebrityName);
    // Translate keywords to English
    const englishKeywords = translateKeywordsToEnglish(keywords);
    queryParts.push(englishKeywords);
    console.log(`  📝 Simplified: "${visualSuggestion.substring(0, 60)}..." → "${keywords}" → EN: "${englishKeywords}"`);
  } else {
    // Transliterate factTitle too
    queryParts.push(transliterate(factTitle));
  }
  
  if (factYear) {
    queryParts.push(String(factYear));
  }

  const query = queryParts.join(' ');
  console.log(`  🔎 Final query (EN): "${query}"`);  
  
  // Get multiple image candidates from Google
  const candidateUrls = await searchGoogleImages(query, 5);
  
  if (candidateUrls.length === 0) {
    return null;
  }

  // Use Gemini to validate and pick the best image
  const description = visualSuggestion || factTitle;
  const bestImage = await findBestImage(candidateUrls, celebrityName, description);

  return bestImage;
}
