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

// Free plan rate limit: 1 request/second. Throttle all calls globally.
let _lastBraveCallTime = 0;
const BRAVE_MIN_INTERVAL_MS = 1200;
async function braveThrottle(): Promise<void> {
  const wait = BRAVE_MIN_INTERVAL_MS - (Date.now() - _lastBraveCallTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastBraveCallTime = Date.now();
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
      console.error(`Brave Search API error: ${response.status} - ${errorText}`);
      return [];
    }

    const data = await response.json() as BraveSearchResponse;

    if (!data.results || data.results.length === 0) {
      console.log(`No Brave images found for: "${query}"`);
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

    console.log(`✅ Brave found ${candidates.length} valid candidates for: "${query}"`);
    return candidates;

  } catch (error) {
    console.error('Brave Image Search error:', error);
    return [];
  }
}
