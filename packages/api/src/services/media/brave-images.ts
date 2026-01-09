/**
 * Brave Search API - backup source for finding images
 * https://brave.com/search/api/
 * 
 * SEARCH STRATEGY:
 * - Brave works best with short keyword queries (2-5 words)
 * - Format: "Name context year photo"
 * - Supports language filtering via search_lang parameter
 */

interface BraveImageResult {
  url: string;
  title: string;
  source: string;
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
  query?: {
    original: string;
  };
}

/**
 * Search for images using Brave Search API
 * @param query Search query (short keywords work best)
 * @param numResults Number of results to return
 * @param lang Search language: 'en' or 'ru'
 * @returns Array of direct image URLs
 */
export async function searchBraveImages(
  query: string,
  numResults: number = 10,
  lang: 'en' | 'ru' = 'en'
): Promise<string[]> {
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

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey
      }
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

    // Filter for direct image URLs and exclude stock photos
    const imageUrls = data.results
      .filter(item => {
        const imageUrl = item.properties?.url || item.url;
        if (!imageUrl) return false;
        
        const lower = imageUrl.toLowerCase();
        return (
          lower.endsWith('.jpg') || 
          lower.endsWith('.jpeg') || 
          lower.endsWith('.png') ||
          lower.includes('.jpg?') ||
          lower.includes('.jpeg?') ||
          lower.includes('.png?')
        );
      })
      .filter(item => {
        // Exclude stock photo sites
        const source = (item.source || '').toLowerCase();
        const url = (item.properties?.url || item.url || '').toLowerCase();
        return !(
          source.includes('gettyimages') ||
          source.includes('shutterstock') ||
          source.includes('istockphoto') ||
          source.includes('alamy') ||
          source.includes('dreamstime') ||
          source.includes('depositphotos') ||
          url.includes('gettyimages') ||
          url.includes('shutterstock') ||
          url.includes('istockphoto')
        );
      })
      .filter(item => {
        // Only large enough images
        const width = item.properties?.width || 0;
        const height = item.properties?.height || 0;
        return width >= 400 || height >= 300 || (width === 0 && height === 0);
      })
      .map(item => item.properties?.url || item.url);

    console.log(`✅ Brave found ${imageUrls.length} valid images for: "${query}"`);
    return imageUrls;

  } catch (error) {
    console.error('Brave Image Search error:', error);
    return [];
  }
}
