/**
 * Brave Search API - backup source for finding images
 * https://brave.com/search/api/
 *
 * Returns ImageCandidate[] — same shape as searchGoogleImages so the orchestrator
 * in google-images.ts can treat all sources uniformly.
 * Each result carries a thumbnailUrl (Brave CDN, ~10–30 KB) for cheap Gemini
 * validation instead of the full original image.
 */

import { type ImageCandidate, scoreByMetadata } from './google-images';

// Free plan rate limit: 1 request/second.
// Throttle all calls with a promise-queue mutex so concurrent EN + RU calls
// are serialized even though they start in the same synchronous tick.
let _braveQueue: Promise<void> = Promise.resolve();
let _lastBraveCallTime = 0;
const BRAVE_MIN_INTERVAL_MS = 2000;

async function braveThrottle(): Promise<void> {
  // Chain onto the previous caller's slot so calls are strictly sequential.
  // Reading + writing _braveQueue happens synchronously before any await,
  // which is critical when multiple callers start in the same tick.
  const prev = _braveQueue;
  let releaseNext!: () => void;
  _braveQueue = new Promise<void>(r => { releaseNext = r; });

  await prev; // wait for previous slot to finish

  const elapsed = Date.now() - _lastBraveCallTime;
  if (elapsed < BRAVE_MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, BRAVE_MIN_INTERVAL_MS - elapsed));
  }
  _lastBraveCallTime = Date.now();
  releaseNext(); // let next queued caller proceed
}

interface BraveImageResult {
  url: string;
  title: string;
  source: string;
  page_fetched?: string;  // page URL where the image appears
  thumbnail: {
    src: string;
  };
  properties: {
    url: string;
    width?: number;
    height?: number;
  };
}

interface BraveSearchResponse {
  results?: BraveImageResult[];
  query?: { original: string };
}

const STOCK_DOMAINS = [
  'gettyimages', 'shutterstock', 'istockphoto', 'alamy',
  'dreamstime', 'depositphotos', 'pond5', 'stocksy',
];

/**
 * Search for images using Brave Search API.
 *
 * @param query       Short keyword query (2–5 words work best)
 * @param numResults  Max results (Brave API caps at 20)
 * @param lang        'en' or 'ru' — controls Brave's search_lang parameter
 * @param personName  Used for metadata scoring; pass for best results
 */
export async function searchBraveImages(
  query: string,
  numResults: number = 10,
  lang: 'en' | 'ru' = 'en',
  personName?: string
): Promise<ImageCandidate[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ Brave Search not configured (BRAVE_SEARCH_API_KEY missing)');
    return [];
  }

  try {
    const url = new URL('https://api.search.brave.com/res/v1/images/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(numResults, 20)));
    url.searchParams.set('safesearch', 'off');
    url.searchParams.set('search_lang', lang);

    console.log(`🦁 Brave [${lang.toUpperCase()}]: "${query}"`);
    await braveThrottle();

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      // On 429: wait 3 s and retry once — saves callers from getting empty results
      // on a single window-boundary collision
      if (response.status === 429) {
        console.warn(`⚠️ Brave 429, retrying after 3 s...`);
        await new Promise(r => setTimeout(r, 3000));
        // One single retry (no infinite loop)
        const retry = await fetch(url.toString(), {
          headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        });
        if (!retry.ok) {
          console.error(`Brave Search API error: ${retry.status} - ${await retry.text()}`);
          return [];
        }
        return processResults(await retry.json() as BraveSearchResponse, personName);
      }
      console.error(`Brave Search API error: ${response.status} - ${errorText}`);
      return [];
    }

    return processResults(await response.json() as BraveSearchResponse, personName);

  } catch (error) {
    console.error('Brave Image Search error:', error);
    return [];
  }
}

function processResults(data: BraveSearchResponse, personName?: string): ImageCandidate[] {
  if (!data.results || data.results.length === 0) {
    return [];
  }
  const candidates: ImageCandidate[] = data.results
    .filter(item => {
      const imageUrl = (item.properties?.url || item.url || '').toLowerCase();
      if (!imageUrl) return false;
      // Must be a direct image URL
      const isImage = imageUrl.endsWith('.jpg') || imageUrl.endsWith('.jpeg') ||
                      imageUrl.endsWith('.png') || imageUrl.includes('.jpg?') ||
                      imageUrl.includes('.jpeg?') || imageUrl.includes('.png?');
      if (!isImage) return false;
      // Exclude stock photo sites
      const isStock = STOCK_DOMAINS.some(d => imageUrl.includes(d) || (item.source ?? '').toLowerCase().includes(d));
      if (isStock) return false;
      // Minimum size
      const w = item.properties?.width ?? 0;
      const h = item.properties?.height ?? 0;
      return w >= 400 || h >= 300 || (w === 0 && h === 0);
    })
    .map(item => {
      const originalUrl = item.properties?.url || item.url;
      const candidate: ImageCandidate = {
        originalUrl,
        // Brave's thumbnail.src is their CDN-proxied small preview (~10–30 KB)
        thumbnailUrl: item.thumbnail?.src,
        title: item.title,
        sourceUrl: item.page_fetched || undefined,
        source: 'brave',
        metadataScore: 0,
      };
      candidate.metadataScore = scoreByMetadata(candidate, personName ?? '');
      return candidate;
    });

  if (candidates.length > 0) {
    console.log(`✅ Brave found ${candidates.length} valid candidates`);
  }
  return candidates;
}