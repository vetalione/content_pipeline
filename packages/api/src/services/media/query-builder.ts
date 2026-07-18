/**
 * AI-powered search query builder for image search.
 *
 * WHY THIS EXISTS:
 * The old pipeline destroyed the carefully crafted `visual_suggestion` from
 * research before it ever reached Google/Brave:
 *   - extractKeywords() matched against a hardcoded ~30-word RU dictionary;
 *     anything outside it was silently dropped (fallback: "vintage photo")
 *   - translateCelebrityName() fell back to a 4-letter prefix match that
 *     could swap the person entirely (Джимми Фэллон → Jim Carrey), then to
 *     naive transliteration (Тимоти Шаламе → "Timoti Shalame")
 *
 * This module makes ONE tiny Gemini Flash call per fact (~150 tokens,
 * fractions of a cent) that:
 *   1. Returns the person's canonical ENGLISH name (correct spelling)
 *   2. Compresses the visual suggestion into 3-6 concrete EN search keywords
 *   3. Produces a short RU keyword string for RU-локальные поисковики
 *
 * Results are memoized in-process, so re-picks ("переподобрать") and repeated
 * section searches for the same fact cost ZERO extra tokens.
 */

import { GoogleGenAI } from '@google/genai';

export interface BuiltQueries {
  /** Canonical English name, e.g. "Michael Jackson" */
  englishName: string;
  /** 3–6 English keywords describing the moment, e.g. "teenager Jackson 5 Motown rehearsal 1973" */
  enKeywords: string;
  /** Short Russian keywords for RU search, e.g. "юность репетиция 1973" (empty if name is already English) */
  ruKeywords: string;
  /**
   * Visual-media era of the subject:
   *  - 'pre_photography': lived before cameras (Aristotle, Pushkin...) —
   *    paintings, engravings, busts, statues are the CORRECT imagery
   *  - 'photography': photographs exist for this person
   */
  era: 'pre_photography' | 'photography';
}

// In-process memoization — re-picks and autopilot retries hit the cache.
const cache = new Map<string, BuiltQueries>();

const MAX_CACHE_ENTRIES = 500;

function cacheKey(celebrityName: string, visualSuggestion: string, factYear?: number): string {
  return `${celebrityName}||${visualSuggestion}||${factYear ?? ''}`;
}

/**
 * Build optimized search queries from the research visual suggestion.
 * Returns null when Gemini is unavailable/fails — caller falls back to the
 * legacy dictionary-based extraction.
 */
export async function buildSearchQueries(
  celebrityName: string,
  visualSuggestion: string,
  factYear?: number,
): Promise<BuiltQueries | null> {
  const key = cacheKey(celebrityName, visualSuggestion, factYear);
  const cached = cache.get(key);
  if (cached) {
    console.log(`  ♻️  Query cache hit for "${celebrityName}"`);
    return cached;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const genAI = new GoogleGenAI({ apiKey });

    const prompt = `You prepare image-search queries for a biography article.

PERSON (as written by our editors, possibly in Russian): "${celebrityName}"
MOMENT TO ILLUSTRATE: "${visualSuggestion}"${factYear ? `\nYEAR OF EVENT: ${factYear}` : ''}

Return JSON only:
{
  "englishName": "<canonical English spelling of the person's name. If you are not 100% sure who this is, transliterate carefully — NEVER substitute a different person>",
  "enKeywords": "<3-6 concrete English keywords capturing the SPECIFIC moment: life period/age, place, activity, era. NO generic filler like 'photo' or 'image'. Example: 'teenager Jackson 5 Motown rehearsal 1973'. For pre-photography figures use art terms: 'portrait painting', 'engraving', 'bust', 'statue'>",
  "ruKeywords": "<2-4 Russian keywords for the same moment, e.g. 'юность репетиция Motown'. Empty string if the person is not known in Russian-speaking media>",
  "era": "<'pre_photography' if the person died before ~1850 (no photographs can exist — paintings/engravings/busts are the correct imagery), otherwise 'photography'>"
}`;

    // Retry transient failures (429/503/network) AND empty/JSON-less responses.
    // gemini-3-flash-preview is a thinking model: its reasoning tokens count
    // against maxOutputTokens, so a tight limit (the old 300) gets fully eaten
    // by thoughts and .text comes back EMPTY → "No JSON" → every fact degraded
    // to the legacy transliteration fallback ("Sokrat ... photo"). Generous
    // limit + forced JSON mime type + retry-on-empty fix all three failure modes.
    let parsed: any;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await genAI.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            temperature: 0.1,
            maxOutputTokens: 2000,
            responseMimeType: 'application/json',
          },
        });
        const text = result.text ?? '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error(`No JSON in query-builder response (text length=${text.length})`);
        }
        parsed = JSON.parse(jsonMatch[0]);
        break;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const isTransient =
          msg.includes('429') || msg.includes('503') || msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('UNAVAILABLE') || msg.includes('overloaded') ||
          msg.includes('fetch failed') || msg.includes('timeout') ||
          msg.includes('No JSON') || msg.includes('JSON');  // empty/garbled output — retry too
        if (!isTransient || attempt === maxAttempts) throw err;
        console.log(`  ⏳ Query builder transient error (attempt ${attempt}/${maxAttempts}): ${msg.substring(0, 80)} — retrying...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    if (!parsed.englishName || typeof parsed.englishName !== 'string') {
      throw new Error('query-builder returned no englishName');
    }

    const built: BuiltQueries = {
      englishName: String(parsed.englishName).trim(),
      enKeywords: String(parsed.enKeywords ?? '').trim(),
      ruKeywords: String(parsed.ruKeywords ?? '').trim(),
      era: parsed.era === 'pre_photography' ? 'pre_photography' : 'photography',
    };

    // Bounded cache (FIFO eviction) — protects long-running processes
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, built);

    console.log(`  🧠 Query builder: "${celebrityName}" → "${built.englishName}" | EN: "${built.enKeywords}" | RU: "${built.ruKeywords}"`);
    return built;
  } catch (error: any) {
    console.warn(`  ⚠️ Query builder failed (${error?.message ?? error}) — falling back to legacy keyword extraction`);
    return null;
  }
}
