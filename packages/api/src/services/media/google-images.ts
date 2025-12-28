/**
 * Google Custom Search API for finding images
 */

import { findBestImage } from './gemini-image-validator';

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
 * Find image for a specific biography fact
 * Constructs search query from fact details and validates with Gemini
 */
export async function findFactImage(
  celebrityName: string,
  factTitle: string,
  factYear?: number,
  visualSuggestion?: string
): Promise<string | null> {
  // Build search query - ALWAYS include celebrity name first and "photo" keyword
  // to prioritize images showing the person themselves
  const queryParts = [celebrityName, 'photo'];
  
  if (visualSuggestion) {
    queryParts.push(visualSuggestion);
  } else {
    queryParts.push(factTitle);
  }
  
  if (factYear) {
    queryParts.push(String(factYear));
  }

  const query = queryParts.join(' ');
  
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
