/**
 * Image Search Orchestrator
 * Combines Google, Brave, and Perplexity for comprehensive image search
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * SEARCH STRATEGY BY SOURCE:
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * 📍 GOOGLE CUSTOM SEARCH (EN + RU)
 * ─────────────────────────────────
 * Best for: Large coverage, stock-free results via CSE filters
 * Query format: SHORT KEYWORDS only, no sentences!
 * 
 * EN: "Name context_keyword year photo"
 *     Example: "Steve Jobs garage 1976 photo"
 * 
 * RU: "Имя контекст год [архивное/редкое] фото"
 *     Example: "Стив Джобс гараж 1976 архивное фото"
 *     - Uses "архивное фото" for pre-1970
 *     - Uses "редкое фото" for 1970-2000
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * 🦁 BRAVE SEARCH (EN + RU)
 * ─────────────────────────
 * Best for: Alternative index, fresh results, Russian archives
 * Query format: Same as Google - short keywords
 * 
 * - Supports language filtering via search_lang parameter
 * - EN search: Same query as Google EN
 * - RU search: Same query as Google RU (for Russian celebrities)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * 🔮 PERPLEXITY SONAR PRO (AI-powered)
 * ────────────────────────────────────
 * Best for: Contextual understanding, rare photos, smart filtering
 * Query format: NATURAL LANGUAGE with full context
 * 
 * - Understands temporal context ("childhood in the 1960s")
 * - Can interpret visual descriptions
 * - Filters collages and stock photos via system prompt
 * - Prioritizes Wikipedia, Wikimedia Commons, Archive.org
 * 
 * System prompt instructs to:
 * - Find SINGLE PERSON photos only
 * - Match time period accurately
 * - Avoid collages and montages
 * - Prefer documentary-style photos
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { promises as fs } from 'fs';
import { batchValidateImages } from './gemini-image-validator';
import { searchBraveImages } from './brave-images';
import { searchPerplexityImages } from './perplexity-images';
import { searchOpenAIImages } from './openai-images';
import { getWikipediaImages, searchWikimediaCommons } from './wikipedia-images';
import { buildSearchQueries } from './query-builder';

// ─────────────────────────────────────────────────────────────────────────────
// Core shared type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single image candidate from any search source.
 *
 * KEY FIELD: thumbnailUrl
 *   When present, Gemini validation uses this (5–30 KB) instead of the full
 *   original (500 KB–5 MB).  That single change cuts image-download bandwidth
 *   by ~95 % and makes validation ~30× cheaper.
 *
 * KEY FIELD: metadataScore
 *   A 0–10 pre-computed score based only on URL/title/source — no downloads.
 *   Candidates with score ≥ 8 can bypass Gemini validation entirely.
 */
export interface ImageCandidate {
  originalUrl: string;
  thumbnailUrl?: string;   // Small preview (Google encryptedTBN / Brave CDN / Wikimedia resize)
  title?: string;          // Page/image title — used for metadata scoring
  sourceUrl?: string;      // Page where the image appears (contextLink)
  source: 'google-en' | 'google-ru' | 'brave' | 'perplexity' | 'wikipedia' | 'openai';
  metadataScore: number;   // 0–10, computed without any HTTP request
}

/**
 * Score a candidate using only metadata (title, domain, url).
 * Zero bandwidth, zero API calls.
 *
 * Score guide — ARCHIVAL HIERARCHY:
 *  9 max (cap): reserved for manually assigned top candidates
 *
 *  ARCHIVAL SOURCES (what we actually want for rare fact photos):
 *  +6 : commons.wikimedia.org — dedicated historical photo archive, millions of
 *       rare/historical images, all CC-licensed, no hotlink issues
 *  +6 : archive.org — wayback machine + scanned books/newspapers/photos
 *  +5 : loc.gov / nara.gov / .museum — institutional government/museum archives
 *  +5 : newspapers.com / chroniclingamerica — digitized historical newspapers
 *  +5 : Institutional Flickr (Library of Congress, Smithsonian, National Archives)
 *
 *  GENERAL SOURCES (correct person but often mainstream headshots):
 *  +4 : wikipedia.org (main article) — canonical photo but usually the most
 *       recognizable mainstream portrait, rarely rare
 *  +3 : britannica.com / biography.com / imdb.com
 *  +2 : .gov (general), sites with "archive" in URL
 *
 *  TEMPORAL MATCHING (bonus when photo year aligns with the fact's year):
 *  +3 : Exact year in title or image URL
 *  +2 : Year ±2 in title
 *  +1 : Same decade in title/URL
 *  +1 : Archival markers in title for pre-1980 facts (b&w, vintage, historic)
 *
 *  PERSON MATCHING:
 *  +2 per name part found in title or image URL (max 2 parts usually)
 */
export function scoreByMetadata(
  candidate: Pick<ImageCandidate, 'title' | 'sourceUrl' | 'originalUrl'>,
  personName: string,
  factYear?: number,
): number {
  let score = 0;
  const name = personName.toLowerCase();
  const sourceUrl = (candidate.sourceUrl ?? '').toLowerCase();
  const title = (candidate.title ?? '').toLowerCase();
  const imageUrl = (candidate.originalUrl ?? '').toLowerCase();

  // ── Archival source hierarchy ─────────────────────────────────────────────
  // commons.wikimedia.org is completely different from wikipedia.org:
  //   wikipedia.org = the encyclopedia article → usually the mainstream headshot
  //   commons.wikimedia.org = historical photo archive → rare archival photos
  if (sourceUrl.includes('commons.wikimedia.org') || imageUrl.includes('commons.wikimedia.org')) {
    score += 6;
  } else if (sourceUrl.includes('archive.org') || imageUrl.includes('archive.org')) {
    score += 6;
  } else if (
    sourceUrl.includes('loc.gov') ||
    sourceUrl.includes('nara.gov') ||
    sourceUrl.includes('.museum') ||
    (sourceUrl.includes('.gov') && (sourceUrl.includes('photo') || sourceUrl.includes('image') || sourceUrl.includes('archive')))
  ) {
    score += 5; // Government / institutional archives
  } else if (
    // Museum digital collections — the RIGHT source for pre-photography figures
    // (paintings, engravings, busts) and often for rare historical photos too
    sourceUrl.includes('metmuseum.org') ||
    sourceUrl.includes('npg.org.uk') ||
    sourceUrl.includes('nationalgallery') ||
    sourceUrl.includes('hermitagemuseum.org') ||
    sourceUrl.includes('louvre.fr') ||
    sourceUrl.includes('rijksmuseum.nl') ||
    sourceUrl.includes('getty.edu') ||
    sourceUrl.includes('si.edu') ||
    sourceUrl.includes('europeana.eu') ||
    sourceUrl.includes('tretyakovgallery') ||
    sourceUrl.includes('rusmuseum')
  ) {
    score += 5;
  } else if (
    sourceUrl.includes('newspapers.com') ||
    sourceUrl.includes('chroniclingamerica') ||
    sourceUrl.includes('newspapers.library')
  ) {
    score += 5; // Historical newspaper archives
  } else if (
    sourceUrl.includes('flickr.com') &&
    (sourceUrl.includes('library_of_congress') || sourceUrl.includes('national_archives') ||
     sourceUrl.includes('smithsonian') || sourceUrl.includes('commons'))
  ) {
    score += 5; // Institutional Flickr collections (public domain)
  } else if (sourceUrl.includes('wikipedia.org')) {
    score += 4; // Correct person, but usually mainstream headshot
  } else if (
    sourceUrl.includes('britannica.com') ||
    sourceUrl.includes('biography.com') ||
    sourceUrl.includes('imdb.com') ||
    sourceUrl.includes('history.com')
  ) {
    score += 3;
  } else if (
    // Reputable press — the PRIMARY source of rare early-career shots for
    // modern/emerging celebrities (rappers, young stars) who have no
    // Wikimedia/archive presence yet
    sourceUrl.includes('rollingstone.com') ||
    sourceUrl.includes('billboard.com') ||
    sourceUrl.includes('variety.com') ||
    sourceUrl.includes('hollywoodreporter.com') ||
    sourceUrl.includes('theguardian.com') ||
    sourceUrl.includes('nytimes.com') ||
    sourceUrl.includes('washingtonpost.com') ||
    sourceUrl.includes('bbc.co') ||
    sourceUrl.includes('complex.com') ||
    sourceUrl.includes('pitchfork.com') ||
    sourceUrl.includes('xxlmag.com') ||
    sourceUrl.includes('vulture.com') ||
    sourceUrl.includes('gq.com') ||
    sourceUrl.includes('vanityfair.com') ||
    sourceUrl.includes('kommersant.ru') ||
    sourceUrl.includes('kp.ru') ||
    sourceUrl.includes('ria.ru') ||
    sourceUrl.includes('tass.ru')
  ) {
    score += 3;
  } else if (sourceUrl.includes('.gov') || sourceUrl.includes('archive')) {
    score += 2;
  }

  // ── Person name matching ──────────────────────────────────────────────────
  const nameParts = name.split(' ').filter(p => p.length > 2);
  const matchedParts = nameParts.filter(p => title.includes(p) || imageUrl.includes(p));
  score += matchedParts.length * 2;

  // ── Temporal matching ─────────────────────────────────────────────────────
  // This is key for rare fact photos: a blurry 1965 photo that matches the
  // fact year is MORE VALUABLE than a crisp 2020 headshot.
  if (factYear) {
    const decade = Math.floor(factYear / 10) * 10;
    const yearStr = String(factYear);
    const decadeStr = String(decade);

    if (title.includes(yearStr) || imageUrl.includes(yearStr)) {
      score += 3; // Exact year match
    } else if (
      title.includes(String(factYear - 1)) || title.includes(String(factYear + 1)) ||
      title.includes(String(factYear - 2)) || title.includes(String(factYear + 2)) ||
      imageUrl.includes(String(factYear - 1)) || imageUrl.includes(String(factYear + 1))
    ) {
      score += 2; // Year ±2
    } else if (title.includes(decadeStr) || imageUrl.includes(decadeStr)) {
      score += 1; // Same decade
    }

    // For old facts: b&w/vintage markers in title = era-appropriate
    if (factYear < 1980 && (
      title.includes('black') || title.includes('white') || title.includes('b&w') ||
      title.includes('vintage') || title.includes('archive') || title.includes('historic')
    )) {
      score += 1;
    }
  }

  return Math.min(score, 9); // Cap at 9; only designated canonical images get 10
}

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
  
  // Check partial matches (for declensions like "Николы Теслы").
  // SAFETY: require BOTH name parts to prefix-match (6+ chars on the first).
  // The old 4-letter single-word match could swap the person entirely
  // (e.g. "Джимми Фэллон" → "Jim Carrey" via "джим").
  const nameWords = lowerName.split(' ').filter(Boolean);
  for (const [ru, en] of Object.entries(CELEBRITY_TRANSLATIONS)) {
    const ruWords = ru.split(' ');
    if (ruWords.length !== nameWords.length) continue;
    const allPartsMatch = ruWords.every((rw, i) => {
      const nw = nameWords[i];
      const prefixLen = Math.min(Math.max(rw.length - 2, 4), 6);
      return nw.startsWith(rw.substring(0, prefixLen)) || rw.startsWith(nw.substring(0, prefixLen));
    });
    if (allPartsMatch) return en;
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
 * Search for images using Google Custom Search API.
 *
 * Returns ImageCandidate[] — each item carries:
 *   • originalUrl   — full-size image for display
 *   • thumbnailUrl  — Google's encrypted thumbnail (~5–15 KB, vs ~500 KB+ for original)
 *                     Used by Gemini validation to cut bandwidth 95 %
 *   • metadataScore — pre-computed relevance without any download
 *
 * @param query       Short keyword query, e.g. "Steve Jobs garage 1976 photo"
 * @param numResults  Max results (Google API hard-caps at 10)
 * @param personName  Used for metadata scoring; optional
 */
export async function searchGoogleImages(
  query: string,
  numResults: number = 3,
  personName?: string
): Promise<ImageCandidate[]> {
  // Trim + strip accidental quotes: a Railway variable pasted with a trailing
  // newline, space or wrapping quotes passes the truthiness check but reaches
  // Google as an effectively empty/garbled `key=` → 401 CREDENTIALS_MISSING.
  const apiKey = (process.env.GOOGLE_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  const cx = (process.env.GOOGLE_CX || '').trim().replace(/^["']|["']$/g, '');

  if (!apiKey || !cx) {
    console.warn('⚠️ Google Custom Search not configured (GOOGLE_API_KEY or GOOGLE_CX missing/empty after trim)');
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
      console.error(`Google Search API error: ${response.status} - ${errorText.substring(0, 400)}`);
      if (response.status === 401) {
        // CREDENTIALS_MISSING → the key never reached Google in usable form.
        // Log a masked fingerprint so a corrupted Railway variable is visible.
        console.error(
          `   🔑 GOOGLE_API_KEY diagnostic: length=${apiKey.length}, ` +
          `starts="${apiKey.substring(0, 4)}...", looksLikeGoogleKey=${/^AIza[0-9A-Za-z_-]{30,}$/.test(apiKey)}. ` +
          `Проверь переменную GOOGLE_API_KEY в Railway: без кавычек, пробелов и переносов строки.`
        );
      }
      return [];
    }

    const data = await response.json() as GoogleSearchResponse;

    if (!data.items || data.items.length === 0) {
      console.log(`No images found for: "${query}"`);
      return [];
    }

    const candidates: ImageCandidate[] = data.items
      .filter(item => {
        const lower = (item.link ?? '').toLowerCase();
        return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') ||
               lower.includes('.jpg?') || lower.includes('.jpeg?') || lower.includes('.png?');
      })
      .map(item => {
        const candidate: ImageCandidate = {
          originalUrl: item.link,
          // Google always returns thumbnailLink — use it for cheap Gemini validation
          thumbnailUrl: item.image?.thumbnailLink,
          title: item.title,
          sourceUrl: item.image?.contextLink,
          source: 'google-en', // caller overrides to 'google-ru' if needed
          metadataScore: 0,
        };
        // factYear not available in searchGoogleImages (it's a generic search helper);
        // temporal scoring happens in findFactImage via scoreByMetadata with factYear.
        candidate.metadataScore = scoreByMetadata(candidate, personName ?? '');
        return candidate;
      });

    console.log(`✅ Google found ${candidates.length} candidates for: "${query}"`);
    return candidates;

  } catch (error) {
    console.error('Google Image Search error:', error);
    return [];
  }
}

/**
 * Simplify overly specific description to a more general one
 * Used as fallback when strict search fails
 */
function simplifyDescription(description: string, celebrityName: string): string {
  // Extract the core theme/era from the description
  const lowered = description.toLowerCase();
  
  // Detect era/age
  let era = '';
  if (lowered.includes('детств') || lowered.includes('child') || lowered.includes('маленьк') || lowered.includes('юн')) {
    era = 'childhood/young';
  } else if (lowered.includes('молод') || lowered.includes('young') || lowered.includes('ранн') || lowered.includes('early')) {
    era = 'early career';
  } else if (lowered.includes('1980') || lowered.includes('1990') || lowered.includes('2000')) {
    const yearMatch = description.match(/(19\d{2}|200\d)/);
    if (yearMatch) era = yearMatch[0] + 's';
  }
  
  // Detect theme
  let theme = '';
  if (lowered.includes('семь') || lowered.includes('family') || lowered.includes('отец') || lowered.includes('мать') || lowered.includes('father') || lowered.includes('mother')) {
    theme = 'family';
  } else if (lowered.includes('концерт') || lowered.includes('сцен') || lowered.includes('выступ') || lowered.includes('stage') || lowered.includes('perform')) {
    theme = 'performing';
  } else if (lowered.includes('интервью') || lowered.includes('interview') || lowered.includes('пресс')) {
    theme = 'interview';
  } else if (lowered.includes('провал') || lowered.includes('банкрот') || lowered.includes('failure') || lowered.includes('bankrupt') || lowered.includes('труд')) {
    theme = 'difficult times';
  } else if (lowered.includes('футбол') || lowered.includes('soccer') || lowered.includes('спорт') || lowered.includes('sport')) {
    theme = 'sports';
  }
  
  // Build simplified description
  const parts = [celebrityName];
  if (era) parts.push(era);
  if (theme) parts.push(theme);
  
  // Fallback to just the name + generic context
  if (parts.length === 1) {
    parts.push('vintage photo portrait');
  }
  
  const simplified = parts.join(' ');
  console.log(`  📝 Simplified description: "${description.substring(0, 50)}..." → "${simplified}"`);
  return simplified;
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
 * Extract key Russian search terms from visual suggestion
 * For Google RU - keeps terms in Russian for better local search
 */
function extractKeywordsRussian(visualSuggestion: string, celebrityName: string): string {
  let cleaned = visualSuggestion
    .replace(new RegExp(celebrityName, 'gi'), '')
    .replace(/редкое фото/gi, '')
    .replace(/фото/gi, '')
    .replace(/[«»""]/g, '')
    .trim();
  
  const keywords: string[] = [];
  const cleanedLower = cleaned.toLowerCase();
  
  // Priority Russian keywords for search
  const ruKeywords: string[] = [
    // Life stages
    'детство', 'юность', 'молодость', 'школьные годы',
    // Events
    'свадьба', 'премьера', 'награждение', 'интервью',
    // Contexts
    'на сцене', 'за работой', 'с семьей', 'дома',
    // Negative events
    'банкротство', 'арест', 'суд', 'провал',
    // Style
    'портрет', 'архив'
  ];
  
  for (const kw of ruKeywords) {
    if (cleanedLower.includes(kw.split(' ')[0])) {
      keywords.push(kw);
      if (keywords.length >= 2) break;
    }
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
  useOpenAI?: boolean;
  confidenceThreshold?: number;
  /**
   * QUALITY FLOOR: candidates whose Gemini confidence is below this are NEVER
   * selected — better no image than a dog collar. This is what used to make
   * "re-pick" degrade with every click: with used images excluded, the code
   * happily walked down to 5–20% candidates. Default 55.
   */
  minAcceptableConfidence?: number;
  resultsPerSource?: number;
  excludeUrls?: string[];  // Web URLs to exclude (already used as source)
  /**
   * Local `/images/...` paths (what is stored in article.content.sections[].imageUrl
   * and article.researchData.facts[].imageUrl) to exclude. When the pipeline
   * finishes downloading a candidate, if its cached local path matches any of
   * these, the next-best candidate is downloaded instead. Combined with
   * content-hash-based caching in `downloadAndCacheImage`, this reliably
   * prevents the same image from being assigned to multiple facts/sections
   * even when two different search engines surface it via different URLs.
   */
  excludeLocalPaths?: string[];
  /**
   * Set to true for article COVER / header image — uses Wikipedia Tier 0
   * (returns the most recognizable mainstream headshot, perfect for audience recognition).
   *
   * Leave false (default) for FACT images — skips Wikipedia's mainstream headshot
   * and instead searches Wikimedia Commons (archival/historical photos) + other
   * rare sources so each fact gets an era-appropriate, non-mainstream image.
   */
  isCoverPhoto?: boolean;
  /**
   * Called with ALL Gemini-scored candidates (best-first) after validation,
   * regardless of whether a winner was auto-selected. Lets the UI offer a
   * manual "pick one of these" gallery instead of a dead-end when nothing
   * clears the quality floor.
   */
  onCandidates?: (candidates: ScoredImageCandidate[]) => void;
}

/** A validated candidate exposed to the UI for manual selection. */
export interface ScoredImageCandidate {
  originalUrl: string;
  thumbnailUrl?: string;
  sourceUrl?: string;
  source: string;
  confidence: number;    // Gemini score 0–100
  metadataScore: number;
}

/**
 * Check if URL likely contains a collage/grid image
 */
function isLikelyCollage(url: string): boolean {
  const collagePatterns = [
    /collage/i,
    /grid/i,
    /through.?the.?years/i,
    /evolution/i,
    /timeline/i,
    /transformation/i,
    /then.?and.?now/i,
    /before.?after/i,
    /comparison/i,
    /compilation/i,
    /montage/i,
    /multiple/i,
    /collection/i,
  ];
  
  return collagePatterns.some(pattern => pattern.test(url));
}

/**
 * Find image for a specific biography section/fact.
 *
 * NEW 3-TIER PIPELINE (replaces the old single-pass approach):
 *
 *  ┌─────────────────────────────────────────────────────────────────┐
 *  │ TIER 0 — Wikipedia (FREE, zero Gemini cost, ~70 % hit rate)     │
 *  │  • Hits English + Russian Wikipedia for the celebrity's image   │
 *  │  • metadataScore=10 → no Gemini validation needed               │
 *  │  • Returns immediately if found AND context is generic portrait │
 *  └──────────────────────────┬──────────────────────────────────────┘
 *                             │ not found / context too specific
 *  ┌──────────────────────────▼──────────────────────────────────────┐
 *  │ TIER 1 — Parallel web search (Google EN/RU + Brave + Perplexity)│
 *  │  • All sources now return ImageCandidate[] with thumbnailUrl    │
 *  │  • Metadata scoring filters candidates BEFORE any HTTP request  │
 *  │  • High-score candidates (from Wikipedia domains) skip Gemini   │
 *  └──────────────────────────┬──────────────────────────────────────┘
 *                             │ top-N candidates by metadata score
 *  ┌──────────────────────────▼──────────────────────────────────────┐
 *  │ TIER 2 — Batch Gemini validation (thumbnails, 4 per request)    │
 *  │  • Fetches thumbnailUrl (5–30 KB) NOT originalUrl (500 KB+)     │
 *  │  • 4 images → 1 Gemini call (was: 4 calls before)              │
 *  │  • Early exit when confidence ≥ threshold                       │
 *  │  • Returns originalUrl of winner for display                    │
 *  └─────────────────────────────────────────────────────────────────┘
 *
 * NET EFFECT vs. old approach (per article, 8-9 sections):
 *   ~70 % of sections: Wikipedia hit → 0 Gemini calls, ~0 KB downloaded
 *   ~30 % of sections: thumbnails used → ~95 % less bandwidth per section
 *                       batch Gemini → ~4× fewer API calls per section
 */
export async function findFactImage(
  celebrityName: string,
  factTitle: string,
  factYear?: number,
  visualSuggestion?: string,
  onProgress?: (progress: { stage: string; current: number; total: number; confidence?: number }) => void,
  options?: ImageSearchOptions
): Promise<string | null> {
  const {
    useGoogle = true,
    useBrave = true,
    usePerplexity = true,
    useOpenAI = false,
    confidenceThreshold = 75,
    resultsPerSource = 3,
    excludeUrls = [],
    excludeLocalPaths = [],
  } = options ?? {};

  // Quality floor never exceeds the user's early-exit threshold (otherwise a
  // candidate could pass early-exit yet be rejected by the floor).
  const minAcceptableConfidence = Math.min(options?.minAcceptableConfidence ?? 55, confidenceThreshold);

  const excludedUrlSet = new Set(excludeUrls.map(u => u.toLowerCase()));
  const excludedLocalSet = new Set(excludeLocalPaths.map(u => u.toLowerCase()));
  const nameIsEnglish = isEnglishName(celebrityName);

  // ── AI query preparation (one cheap cached Gemini Flash call per fact) ────
  // Produces the canonical English name + keywords that PRESERVE the specific
  // moment from visual_suggestion. Falls back to legacy dictionary logic if
  // Gemini is unavailable.
  const built = await buildSearchQueries(
    celebrityName,
    visualSuggestion ?? factTitle,
    factYear,
  );

  const englishName = built?.englishName || translateCelebrityName(celebrityName);

  console.log(`  👤 Name: "${celebrityName}" → "${englishName}"${built ? ' (AI)' : ' (legacy)'}`);

  // ── TIER 0: Recognition photo (cover/header only) ───────────────────────
  //
  // Wikipedia's lead article image = the most mainstream, well-known headshot.
  // This is EXACTLY what we want for the article COVER (audience recognition),
  // but it is the WRONG choice for individual fact images because:
  //   - Research methodology explicitly excludes Wikipedia as "too superficial"
  //   - Fact images should illustrate a SPECIFIC archival moment, not a promo shot
  //   - Using the same mainstream headshot for every fact kills editorial value
  //
  // For fact images we instead search Wikimedia COMMONS (the archival photo
  // database) — same network but totally different results.
  if (options?.isCoverPhoto) {
    const wikiCandidates = await getWikipediaImages(
      englishName,
      nameIsEnglish ? undefined : celebrityName
    );
    if (wikiCandidates.length > 0) {
      const best = wikiCandidates[0];
      console.log(`  ✅ TIER 0 (Wikipedia cover): ${best.originalUrl}`);
      if (onProgress) onProgress({ stage: 'found', current: 1, total: 1, confidence: 99 });
      return downloadAndCacheImage(best.originalUrl, best.thumbnailUrl);
    }
    // Fall through: Wikipedia has no image for this person, use normal search
    console.log(`  ⚠️ Wikipedia has no image, falling through to normal search`);
  }

  // ── Build search queries ──────────────────────────────────────────────────
  // Prefer AI-built keywords (they keep the specific moment: age, place,
  // activity, era). Legacy dictionary extraction is the fallback only.
  let keywords = built?.enKeywords || '';
  let keywordsRu = built?.ruKeywords || '';
  if (!keywords && visualSuggestion) {
    keywords = extractKeywords(visualSuggestion, celebrityName);
  }
  if (!keywordsRu && visualSuggestion) {
    keywordsRu = extractKeywordsRussian(visualSuggestion, celebrityName);
  }

  // Pre-photography figures: searching for "photo" of Aristotle returns memes
  // and movie stills — search for portraits/paintings/engravings instead.
  const isPrePhoto = built?.era === 'pre_photography';

  const enQueryParts = [englishName];
  if (keywords) enQueryParts.push(keywords);
  // Only add year separately if it's not already embedded in the extracted keywords
  if (factYear && !keywords.includes(String(factYear))) enQueryParts.push(String(factYear));
  const enMediaWord = isPrePhoto ? 'portrait painting' : 'photo';
  if (!keywords.toLowerCase().includes('photo') && !keywords.toLowerCase().includes('painting') && !keywords.toLowerCase().includes('engraving')) {
    enQueryParts.push(enMediaWord);
  }
  const enQuery = enQueryParts.join(' ');
  console.log(`  🔎 Google EN: "${enQuery}"`);

  let ruQuery = '';
  if (!nameIsEnglish) {
    const ruParts = [celebrityName];
    if (keywordsRu) ruParts.push(keywordsRu);
    if (factYear && !keywordsRu.includes(String(factYear))) ruParts.push(String(factYear));
    ruParts.push(
      isPrePhoto ? 'портрет картина'
        : factYear && factYear < 1970 ? 'архивное фото'
        : factYear && factYear < 2000 ? 'редкое фото'
        : 'фото'
    );
    ruQuery = ruParts.join(' ');
    console.log(`  🔎 Google RU: "${ruQuery}"`);
  }

  // ── TIER 1: Parallel web search ───────────────────────────────────────────
  const searches: Promise<ImageCandidate[]>[] = [];

  if (useGoogle) {
    searches.push(
      searchGoogleImages(enQuery, resultsPerSource, celebrityName).then(cs => cs.map(c => ({ ...c, source: 'google-en' as const })))
    );
    if (ruQuery) {
      searches.push(
        searchGoogleImages(ruQuery, Math.max(2, Math.floor(resultsPerSource * 0.8)), celebrityName)
          .then(cs => cs.map(c => ({ ...c, source: 'google-ru' as const })))
      );
    }
  }
  if (useBrave) {
    searches.push(searchBraveImages(enQuery, resultsPerSource, 'en', celebrityName));
    if (ruQuery) {
      searches.push(
        searchBraveImages(ruQuery, Math.max(2, Math.floor(resultsPerSource * 0.6)), 'ru', celebrityName)
      );
    }
  }
  if (usePerplexity) {
    // Pass visual_suggestion as-is (not stripped) — it was carefully crafted in
    // the research prompt to describe a specific rare archival moment.
    const searchDesc = visualSuggestion ?? `${englishName} ${factTitle}`;
    searches.push(searchPerplexityImages(searchDesc, resultsPerSource, celebrityName, factYear));
  }
  if (useOpenAI) {
    // GPT-5 with the built-in web_search tool — asks the model to browse the
    // web and return a JSON list of direct image URLs. Same role as Perplexity
    // (AI-driven, context-aware search), but a completely different index/crawl.
    const searchDesc = visualSuggestion ?? `${englishName} ${factTitle}`;
    searches.push(searchOpenAIImages(searchDesc, resultsPerSource, celebrityName, factYear));
  }

  // Wikimedia Commons: free archival search (no API key needed).
  // Better than Wikipedia for FACTS: searches the full Commons archive by keyword+year,
  // not just the single lead image of the article.
  // Result scores via scoreByMetadata: commons.wikimedia.org = +6 (highest tier)
  searches.push(searchWikimediaCommons(englishName, keywords || factTitle, factYear));

  const searchResults = await Promise.all(searches);

  // No Wikipedia candidates pre-seeded — they were either used in isCoverPhoto
  // mode (returned early above) or deliberately skipped for fact images.
  const allCandidates: ImageCandidate[] = [];
  for (const batch of searchResults) {
    for (const c of batch) {
      console.log(`  📊 ${c.source}: score=${c.metadataScore} ${c.originalUrl.substring(0, 60)}...`);
      allCandidates.push(c);
    }
  }

  // ── Deduplicate & filter ──────────────────────────────────────────────────
  const seen = new Set<string>();
  const unique: ImageCandidate[] = [];
  let skipped = 0;

  for (const c of allCandidates) {
    const key = c.originalUrl.toLowerCase();
    if (seen.has(key)) continue;
    if (excludedUrlSet.has(key)) { skipped++; continue; }
    // A URL we already downloaded earlier (this article or this process) that
    // resolved to an already-used local file — drop it BEFORE it wastes a
    // Gemini validation slot and possibly wins the batch as a duplicate.
    const knownLocal = urlToLocalCache.get(key);
    if (knownLocal && excludedLocalSet.has(knownLocal.toLowerCase())) { skipped++; continue; }
    if (isLikelyCollage(c.originalUrl)) { skipped++; continue; }
    seen.add(key);
    unique.push(c);
  }

  if (skipped) console.log(`  🔄 Filtered ${skipped} duplicates/collages/excluded`);
  console.log(`  📷 Unique candidates: ${unique.length}`);

  if (unique.length === 0) return null;

  // ── Metadata fast-track: skip Gemini for very high-scoring candidates ─────
  // score=10 means Wikipedia canonical → trust it. (Skip if already used.)
  const topByMeta = unique.find(c =>
    c.metadataScore >= 10 &&
    !excludedUrlSet.has(c.originalUrl.toLowerCase())
  );
  if (topByMeta) {
    console.log(`  ✅ Metadata fast-track (score=10): ${topByMeta.originalUrl.substring(0, 80)}`);
    if (onProgress) onProgress({ stage: 'found', current: 1, total: 1, confidence: 95 });
    return topByMeta.originalUrl;
  }

  // ── TIER 2: Batch Gemini validation (thumbnails) ──────────────────────────
  // Sort by metadata score descending so we validate the most promising first
  const sorted = [...unique].sort((a, b) => b.metadataScore - a.metadataScore);

  // Take top 8 candidates maximum (keeps cost bounded regardless of source count)
  const toValidate = sorted.slice(0, 8);

  const description = visualSuggestion ?? factTitle;

  if (onProgress) onProgress({ stage: 'validating', current: 0, total: toValidate.length });

  console.log(`  🔍 TIER 2: batch Gemini validation (${toValidate.length} candidates, 4/request)...`);

  // Collect per-image confidence across all batches so we can rank and iterate
  // (essential for dedup: if the top pick turns out to be already used, we
  // fall through to the next-best candidate instead of giving up).
  type Scored = { c: ImageCandidate; conf: number };
  const scored: Scored[] = [];
  // Candidates that already failed selection (download error / duplicate) —
  // never re-tried on later selection attempts.
  const rejectedKeys = new Set<string>();
  let winner: string | null = null;
  let winnerConf = 0;

  // Walk validated candidates best → worst; return the first that downloads,
  // isn't a duplicate (exact path OR visual dHash match), and clears the
  // quality floor. Called after any promising batch AND once at the end — so
  // a duplicate top pick keeps the search alive instead of killing it.
  const attemptSelection = async (): Promise<string | null> => {
    const ranked = [...scored].sort((a, b) => (b.conf - a.conf) || (b.c.metadataScore - a.c.metadataScore));
    for (const { c, conf } of ranked) {
      if (conf < minAcceptableConfidence) break; // ranked desc — everything after is worse
      const key = c.originalUrl.toLowerCase();
      if (rejectedKeys.has(key)) continue;
      if (excludedUrlSet.has(key)) { rejectedKeys.add(key); continue; }
      const localPath = await downloadAndCacheImage(c.originalUrl, c.thumbnailUrl);
      if (!localPath.startsWith('/images/')) {
        // Download failed entirely (raw URL returned) — a hotlink-protected
        // image would render unreliably in the article anyway. Skip it.
        console.log(`  ⏭️  Unfetchable (hotlink-protected?), skipping: ${c.originalUrl.substring(0, 70)}`);
        rejectedKeys.add(key);
        continue;
      }
      if (excludedLocalSet.has(localPath.toLowerCase()) || excludedUrlSet.has(localPath.toLowerCase())) {
        console.log(`  ⏭️  Downloaded image already used (dup, conf=${conf}%): ${localPath}`);
        rejectedKeys.add(key);
        continue;
      }
      if (await isVisualDuplicate(localPath, excludeLocalPaths)) {
        console.log(`  ⏭️  Visually identical to an already-used image (dHash, conf=${conf}%): ${localPath}`);
        rejectedKeys.add(key);
        continue;
      }
      winnerConf = conf;
      return localPath;
    }
    return null;
  };

  for (let i = 0; i < toValidate.length && !winner; i += 4) {
    const batch = toValidate.slice(i, i + 4);
    const batchResult = await batchValidateImages(batch, celebrityName, description, factYear, built?.era ?? 'photography');
    if (!batchResult) continue;

    if (onProgress) {
      onProgress({
        stage: 'validating',
        current: Math.min(i + 4, toValidate.length),
        total: toValidate.length,
        confidence: batchResult.confidence,
      });
    }

    // Use per-image scores when available (current gemini-image-validator does return them)
    if (Array.isArray(batchResult.scores) && batchResult.scores.length === batch.length) {
      batch.forEach((c, idx) => scored.push({ c, conf: batchResult.scores[idx] ?? 0 }));
    } else {
      scored.push({ c: batch[batchResult.bestIndex], conf: batchResult.confidence });
    }

    if (batchResult.confidence >= confidenceThreshold) {
      console.log(`  🎯 Promising batch (${batchResult.confidence}% ≥ ${confidenceThreshold}%) — attempting selection`);
      // If the top pick turns out to be a duplicate or unfetchable, winner
      // stays null and the loop CONTINUES validating the remaining batches —
      // the old early-exit here abandoned them and left sections empty.
      winner = await attemptSelection();
    }
  }

  // Final pass over everything validated (no-early-exit runs, and runs where
  // later batches added viable candidates after a failed early attempt).
  if (!winner) winner = await attemptSelection();

  // Rank by Gemini confidence (desc), tiebreak by metadata score (desc)
  scored.sort((a, b) => (b.conf - a.conf) || (b.c.metadataScore - a.c.metadataScore));

  // Expose ALL scored candidates to the caller (UI manual-pick gallery).
  // Even when nothing clears the floor, the user can still choose by eye —
  // no more dead-ends in the frontend.
  if (options?.onCandidates) {
    options.onCandidates(
      scored
        .filter(({ c }) => !excludedUrlSet.has(c.originalUrl.toLowerCase()))
        .map(({ c, conf }) => ({
          originalUrl: c.originalUrl,
          thumbnailUrl: c.thumbnailUrl,
          sourceUrl: c.sourceUrl,
          source: c.source,
          confidence: conf,
          metadataScore: c.metadataScore,
        }))
    );
  }

  if (winner) {
    console.log(`  ✅ Selected (conf=${winnerConf}%): ${winner}`);
    if (onProgress) onProgress({ stage: 'found', current: toValidate.length, total: toValidate.length, confidence: winnerConf });
    return winner;
  }

  // NOTE: the old "metadata-ordered fallback" (pick ANY unvalidated candidate
  // by domain score) was removed deliberately — it inserted images Gemini
  // never approved and was a major source of irrelevant photos.
  console.log(`  ❌ No usable candidate: ${scored.length} validated, ${rejectedKeys.size} rejected (duplicates/unfetchable), quality floor ${minAcceptableConfidence}% — returning no image`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-call dedup caches (persist for the process lifetime)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * originalUrl (lowercase) → local cached path.
 * Lets findFactImage drop a candidate BEFORE Gemini validation when the same
 * web URL was already downloaded for a previous fact/section of this article.
 * Without this, an already-used image wastes a validation slot, wins the
 * batch, gets rejected as a duplicate after download — and the search dies
 * with a tiny leftover pool (the "empty sections 3-4 after autopilot" bug).
 */
const urlToLocalCache = new Map<string, string>();

/** local path → 64-bit dHash (null = could not be computed) */
const dhashCache = new Map<string, bigint | null>();

const CACHE_MAX_ENTRIES = 2000;

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= CACHE_MAX_ENTRIES) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, value);
}

/**
 * Difference hash (dHash): grayscale 9×8, compare horizontal neighbors → 64 bits.
 * Robust to recompression, resizing and small crops — exactly the "same Jim
 * Carrey photo from two different sites" case that byte-level SHA misses.
 */
async function computeDHash(buf: Buffer): Promise<bigint | null> {
  try {
    const { data } = await sharp(buf)
      .grayscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let hash = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        hash = (hash << 1n) | (data[y * 9 + x] > data[y * 9 + x + 1] ? 1n : 0n);
      }
    }
    return hash;
  } catch {
    return null;
  }
}

function hammingDistance64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Hashes within this Hamming distance (of 64 bits) are treated as the same photo. */
const DHASH_DUP_THRESHOLD = 8;

async function getDHash(localPath: string): Promise<bigint | null> {
  const cached = dhashCache.get(localPath);
  if (cached !== undefined) return cached;
  let hash: bigint | null = null;
  // Only local cached files can be hashed; raw URLs (failed downloads) are skipped
  if (localPath.startsWith('/images/')) {
    try {
      const storageBase = process.env.STORAGE_PATH || process.cwd();
      const buf = await fs.readFile(path.join(storageBase, localPath.slice(1)));
      hash = await computeDHash(buf);
    } catch {
      hash = null;
    }
  }
  boundedSet(dhashCache, localPath, hash);
  return hash;
}

/**
 * True when the candidate image is visually identical (perceptual dHash) to
 * any already-used image in this article. Catches the same photo re-served
 * by different sources with different bytes/resolution/compression.
 */
async function isVisualDuplicate(candidatePath: string, usedPaths: string[]): Promise<boolean> {
  if (usedPaths.length === 0) return false;
  const candHash = await getDHash(candidatePath);
  if (candHash === null) return false;
  for (const used of usedPaths) {
    const usedHash = await getDHash(used);
    if (usedHash === null) continue;
    if (hammingDistance64(candHash, usedHash) <= DHASH_DUP_THRESHOLD) return true;
  }
  return false;
}

/**
 * Download an image to Railway Volume (/images/) and return the local path.
 *
 * WHY THIS EXISTS — the hotlink problem:
 *   Gemini validates via thumbnail URL (Google CDN / Brave CDN / Wikimedia CDN).
 *   But `originalUrl` often has hotlink protection:
 *     - Servers check the `Referer` header and return 403 if it's not their own domain
 *     - CDN tokens expire (URLs with ?expires=... parameters)
 *     - Some sites block direct embedding in <img> tags from foreign domains
 *
 *   Solution: download the image once, serve it from our own host.
 *   We try `originalUrl` first; if that fails (403/timeout), we try `thumbnailUrl`
 *   as a last resort (lower quality but always accessible — it's Google/Brave/Wikimedia CDN).
 *
 * Returns a local path like `/images/img_1234567890.jpg` served by Express static,
 * or the original URL if both downloads fail (browser will try its luck).
 */
/**
 * If the URL is a Wikimedia Commons wiki page (e.g. /wiki/File:XXX.jpg),
 * resolve it to the actual upload URL via the MediaWiki API.
 * These wiki-page URLs return HTML, not image data — causes 404 on download.
 */
async function resolveWikimediaPageUrl(url: string): Promise<string> {
  const fileMatch = url.match(/commons\.wikimedia\.org\/wiki\/(File:[^#?\s]+)/i);
  if (!fileMatch) return url;
  try {
    const title = decodeURIComponent(fileMatch[1]);
    const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url&format=json&origin=*`;
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return url;
    const data = await res.json() as any;
    const pages = data?.query?.pages;
    if (!pages) return url;
    const imageUrl = (Object.values(pages)[0] as any)?.imageinfo?.[0]?.url as string | undefined;
    if (imageUrl) {
      console.log(`  🔗 Resolved wiki page → ${imageUrl.substring(0, 80)}`);
      return imageUrl;
    }
  } catch { /* fall through to original */ }
  return url;
}

export async function downloadAndCacheImage(
  originalUrl: string,
  thumbnailUrl?: string
): Promise<string> {
  // Resolve Wikimedia Commons page URLs to actual image URLs before attempting download
  const resolvedOriginal = await resolveWikimediaPageUrl(originalUrl);

  // Try originalUrl FIRST for quality — we only download ONE image per section
  // (already validated by Gemini), so the extra attempt is worth it.
  // Fallback to thumbnailUrl (CDN proxy, always accessible) if original fails.
  const urlsToTry = [resolvedOriginal, thumbnailUrl].filter((u): u is string => !!u);
  // De-duplicate: if thumbnail === original (can happen for Wikimedia)
  const uniqueUrls = [...new Set(urlsToTry)];

  for (const url of uniqueUrls) {
    try {
      // Build a Referer that matches the image's own domain — many CDNs/sites
      // allow hotlinking only from their own domain; spoofing it satisfies that check.
      let referer = '';
      try { referer = new URL(url).origin + '/'; } catch { /* ignore malformed URLs */ }

      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          ...(referer ? { 'Referer': referer } : {}),
        },
      });

      if (!response.ok) {
        console.log(`  ⚠️ Download failed (${response.status}): ${url.substring(0, 70)}`);
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) {
        console.log(`  ⚠️ Not an image (${contentType}): ${url.substring(0, 70)}`);
        continue;
      }

      const buffer = await response.arrayBuffer();
      const bytes = Buffer.from(buffer);

      // Reject tiny files — likely placeholders or broken thumbnails
      if (bytes.length < 20_000) {
        console.log(`  ⚠️ Image too small (${(bytes.length / 1024).toFixed(1)} KB), skipping: ${url.substring(0, 70)}`);
        continue;
      }

      // Content-hash filename: two different source URLs that return the same
      // image bytes (very common — same photo on Wikimedia + Getty + fan sites)
      // will produce the same file name and therefore the same local path.
      // This is what makes excludeLocalPaths dedup reliable across search engines.
      const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const ext = contentType.includes('png') ? 'png' : 'jpg';
      const fileName = `img_${sha}.${ext}`;
      const storageBase = process.env.STORAGE_PATH || process.cwd();
      const imagesDir = path.join(storageBase, 'images');
      await fs.mkdir(imagesDir, { recursive: true });
      const fullPath = path.join(imagesDir, fileName);
      const localPath = `/images/${fileName}`;

      boundedSet(urlToLocalCache, originalUrl.toLowerCase(), localPath);

      try {
        await fs.access(fullPath);
        console.log(`  ♻️  Cache hit (${(bytes.length / 1024).toFixed(0)} KB): ${localPath}`);
        return localPath;
      } catch {
        // Not yet cached — write it
      }
      await fs.writeFile(fullPath, bytes);

      const sourceTag = url === resolvedOriginal ? 'original' : 'thumbnail-fallback';
      console.log(`  💾 Cached image (${sourceTag}, ${(bytes.length / 1024).toFixed(0)} KB): ${localPath}`);
      return localPath;

    } catch (err: any) {
      console.log(`  ⚠️ Download error: ${err.message} — ${url.substring(0, 70)}`);
    }
  }

  // Both downloads failed — return original URL and let the browser handle it
  console.log(`  ⚠️ Could not cache image, returning raw URL`);
  return originalUrl;
}

