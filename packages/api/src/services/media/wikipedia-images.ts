/**
 * Wikipedia pageimages API — Tier 0 source
 *
 * WHY THIS EXISTS:
 * Wikipedia's canonical photo of a person is ALWAYS the correct person.
 * No Gemini validation needed → zero image-download cost for famous people.
 * The API is free, no API key required, and returns a resized thumbnail URL.
 *
 * API docs: https://www.mediawiki.org/wiki/Extension:PageImages
 *
 * EXAMPLE:
 *   EN: https://en.wikipedia.org/w/api.php?action=query&titles=Albert+Einstein
 *       &prop=pageimages&piprop=thumbnail|original&pithumbsize=400&format=json
 *
 *   Returns thumbnail.source = "https://upload.wikimedia.org/wikipedia/commons/thumb/.../400px-..."
 *   This URL is already a Wikimedia CDN resize — always the correct person, free forever.
 */

import type { ImageCandidate } from './google-images';
import { scoreByMetadata } from './google-images';

const WIKI_THUMB_SIZE = 400; // px — good enough for article display AND Gemini validation

interface WikiApiPage {
  pageid?: number;
  ns?: number;
  title?: string;
  missing?: string;
  thumbnail?: { source: string; width: number; height: number };
  original?: { source: string; width: number; height: number };
}

interface WikiApiResponse {
  query?: {
    pages?: Record<string, WikiApiPage>;
    redirects?: Array<{ from: string; to: string }>;
  };
}

/**
 * Fetch a single Wikipedia page's lead image.
 * Returns null if page not found or has no image.
 */
async function fetchWikiImage(
  lang: 'en' | 'ru',
  title: string
): Promise<ImageCandidate | null> {
  try {
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('titles', title);
    url.searchParams.set('prop', 'pageimages');
    url.searchParams.set('piprop', 'thumbnail|original');
    url.searchParams.set('pithumbsize', String(WIKI_THUMB_SIZE));
    url.searchParams.set('format', 'json');
    url.searchParams.set('redirects', '1'); // follow redirects automatically
    url.searchParams.set('origin', '*');    // CORS header

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'ContentPipelineBot/1.0 (biography article generator)',
      },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as WikiApiResponse;
    const pages = data?.query?.pages;
    if (!pages) return null;

    const page = Object.values(pages)[0] as WikiApiPage;
    if (!page || page.missing === '' || !page.thumbnail) return null;

    // Ignore tiny images (icons, logos)
    if ((page.thumbnail.width ?? 0) < 80) return null;

    const thumbnailUrl = page.thumbnail.source;
    const originalUrl = page.original?.source ?? thumbnailUrl;

    console.log(`  📚 Wikipedia [${lang}] "${page.title}": ${thumbnailUrl.substring(0, 80)}...`);

    return {
      originalUrl,
      thumbnailUrl,
      title: `${page.title} - Wikipedia (${lang})`,
      sourceUrl: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title ?? title)}`,
      source: 'wikipedia',
      // metadataScore=10: Wikipedia's canonical image — always the correct person.
      // No Gemini validation needed; skip straight to using this image.
      metadataScore: 10,
    };
  } catch {
    return null;
  }
}

/**
 * Try to get the celebrity's Wikipedia image.
 * Tries English Wikipedia first, then Russian if a Russian name is given.
 *
 * Returns an array so it fits the same ImageCandidate[] shape used by other sources.
 * In practice returns 0–2 results (one per language that has an image).
 */
export async function getWikipediaImages(
  englishName: string,
  russianName?: string
): Promise<ImageCandidate[]> {
  const fetches: Promise<ImageCandidate | null>[] = [
    fetchWikiImage('en', englishName),
  ];

  // Only try Russian if name is actually different (i.e., not just transliteration)
  if (russianName && russianName.trim() !== englishName.trim()) {
    fetches.push(fetchWikiImage('ru', russianName));
  }

  const results = await Promise.all(fetches);
  return results.filter((r): r is ImageCandidate => r !== null);
}

/**
 * Search Wikimedia Commons for archival/historical photos.
 *
 * WHY THIS IS BETTER THAN getWikipediaImages FOR FACT IMAGES:
 *   getWikipediaImages returns the single lead image from the article page —
 *   usually the canonical headshot (mainstream, found everywhere, zero rarity).
 *
 *   Wikimedia Commons has MILLIONS of specific historical photos organized by
 *   event, year, topic, and person. Searching "Elvis Presley 1954 Sun Records"
 *   returns actual photos from that specific historical moment, not the
 *   well-known Las Vegas era portrait.
 *
 * All images are public domain or CC-licensed → no hotlink issues.
 * API is free, no API key required.
 *
 * API: https://www.mediawiki.org/wiki/API:Search (namespace 6 = File:)
 */
export async function searchWikimediaCommons(
  englishName: string,
  contextKeywords: string,
  year?: number
): Promise<ImageCandidate[]> {
  try {
    const queryParts = [englishName];
    if (contextKeywords) queryParts.push(contextKeywords);
    if (year) queryParts.push(String(year));
    const searchQuery = queryParts.join(' ');

    const url = new URL('https://commons.wikimedia.org/w/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrsearch', searchQuery);
    url.searchParams.set('gsrnamespace', '6'); // File: namespace only
    url.searchParams.set('gsrlimit', '6');
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|thumburl|mime|extmetadata');
    url.searchParams.set('iiurlwidth', '400');
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'ContentPipelineBot/1.0 (biography article generator)' },
    });

    if (!response.ok) return [];

    const data: any = await response.json();
    const pages = data?.query?.pages;
    if (!pages) return [];

    const candidates: ImageCandidate[] = [];

    for (const page of Object.values(pages) as any[]) {
      const info = page?.imageinfo?.[0];
      if (!info) continue;

      const mime: string = (info.mime ?? '').toLowerCase();
      if (!mime.startsWith('image/jpeg') && !mime.startsWith('image/png')) continue;

      const originalUrl: string = info.url ?? '';
      const thumbUrl: string | undefined = info.thumburl;
      const title: string = page.title ?? '';

      // Skip clearly non-photographic files (logos, diagrams, etc.)
      if (/logo|icon|map|diagram|chart|flag|coat|arms/i.test(title)) continue;
      if (!originalUrl.match(/\.(jpg|jpeg|png)$/i)) continue;

      const candidate: ImageCandidate = {
        originalUrl,
        thumbnailUrl: thumbUrl,
        title,
        sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
        source: 'wikipedia',
        metadataScore: 0,
      };
      // scoreByMetadata will give +6 for commons.wikimedia.org + temporal bonuses
      candidate.metadataScore = scoreByMetadata(candidate, englishName, year);
      candidates.push(candidate);
    }

    if (candidates.length > 0) {
      console.log(`  📚 Wikimedia Commons: ${candidates.length} archival results for "${searchQuery}"`);
    }
    return candidates;
  } catch {
    return [];
  }
}
