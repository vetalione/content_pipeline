/**
 * Perplexity Sonar Pro API for finding images
 * Uses AI-powered search for better contextual matches
 * 
 * SEARCH STRATEGY:
 * - Perplexity is AI-based, so we can give detailed context
 * - Works best with natural language descriptions
 * - Can understand temporal context (years, eras)
 * - Excellent for finding rare/obscure images
 */

interface PerplexityImageResult {
  image_url?: string;
  origin_url?: string;
  url?: string;
}

/**
 * Search for images using Perplexity Sonar Pro API
 * @param query Full descriptive query (visual suggestion + context)
 * @param numResults Number of results to return
 * @param celebrityName Name of the celebrity (for better context)
 * @param year Target year for the photo
 * @returns Array of direct image URLs
 */
export async function searchPerplexityImages(
  query: string,
  numResults: number = 5,
  celebrityName?: string,
  year?: number
): Promise<string[]> {
  const apiKey = process.env.PERPLEXITY_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ Perplexity not configured (PERPLEXITY_API_KEY missing)');
    return [];
  }

  try {
    // Build context-rich query for AI
    let searchContext = query;
    if (celebrityName && !query.toLowerCase().includes(celebrityName.toLowerCase())) {
      searchContext = `${celebrityName}: ${query}`;
    }
    if (year && !query.includes(String(year))) {
      searchContext += ` (circa ${year})`;
    }
    
    console.log(`🔮 Perplexity AI Search: "${searchContext.substring(0, 80)}..."`);

    const systemPrompt = `You are an expert photo researcher specializing in finding rare historical photographs.

YOUR TASK: Find authentic photographs matching the user's description.

REQUIREMENTS:
1. ONE PHOTO per image - NO collages, grids, or montages (multiple people in one photo is OK)
2. Time-period accurate - if a year is mentioned, find photos FROM that era
3. High quality - clear, well-lit photos preferred
4. Documentary style - real photos, not promotional shots

PRIORITY SOURCES (in order):
1. Wikimedia Commons / Wikipedia
2. Archive.org
3. Official biographies
4. News agency archives (AP, Reuters, AFP)
5. Museum digital collections

AVOID:
- Stock photo sites (Getty, Shutterstock, Alamy, iStock)
- Pinterest, Instagram
- Collages or "through the years" compilations
- Modern recreations or colorizations (unless specified)
- Low resolution thumbnails

OUTPUT FORMAT:
Return ONLY direct image URLs (ending in .jpg, .jpeg, .png).
One URL per line. No explanations or descriptions.`;

    const userPrompt = `Find ${numResults} authentic photographs matching this description:

"${searchContext}"

Return only direct image URLs, one per line.`;

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 1000,
        return_images: true,
        image_domain_filter: [
          'wikimedia.org',
          'commons.wikimedia.org',
          'wikipedia.org',
          'archive.org',
          '-gettyimages.com',
          '-shutterstock.com',
          '-pinterest.com',
          '-istockphoto.com',
          '-alamy.com',
          '-dreamstime.com',
          '-depositphotos.com'
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Perplexity API error: ${response.status} - ${errorText}`);
      return [];
    }

    const data: any = await response.json();
    
    // Extract images from the response
    const images: string[] = [];
    
    // Method 1: Check data.images array (Perplexity returns images here)
    if (data.images && Array.isArray(data.images)) {
      for (const img of data.images) {
        let url: string | undefined;
        
        if (typeof img === 'string') {
          url = img;
        } else if (img && typeof img === 'object') {
          // Use image_url (direct image), not origin_url (article page)
          url = img.image_url || img.url || img.src;
        }
        
        if (url && isValidImageUrl(url)) {
          images.push(url);
        }
      }
    }
    
    // Method 2: Parse URLs from text response
    const content = data.choices?.[0]?.message?.content || '';
    const urlMatches = content.match(/https?:\/\/[^\s"'<>]+\.(jpg|jpeg|png)(\?[^\s"'<>]*)?/gi);
    
    if (urlMatches) {
      for (const url of urlMatches) {
        if (isValidImageUrl(url) && !images.includes(url)) {
          images.push(url);
        }
      }
    }
    
    // Limit to requested count
    const result = images.slice(0, numResults);
    
    console.log(`✅ Perplexity found ${result.length} images`);
    return result;

  } catch (error) {
    console.error('Perplexity Image Search error:', error);
    return [];
  }
}

/**
 * Check if URL is a valid direct image URL (not stock photo or collage)
 */
function isValidImageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  
  // Must be image extension
  const hasImageExtension = 
    lower.endsWith('.jpg') || 
    lower.endsWith('.jpeg') || 
    lower.endsWith('.png') ||
    lower.includes('.jpg?') ||
    lower.includes('.jpeg?') ||
    lower.includes('.png?');
  
  if (!hasImageExtension) return false;
  
  // Exclude stock photo sites
  const isStockPhoto = 
    lower.includes('gettyimages') ||
    lower.includes('shutterstock') ||
    lower.includes('istockphoto') ||
    lower.includes('alamy') ||
    lower.includes('dreamstime') ||
    lower.includes('depositphotos') ||
    lower.includes('pinterest');
  
  if (isStockPhoto) return false;
  
  // Exclude likely collages by URL patterns
  const isLikelyCollage =
    lower.includes('collage') ||
    lower.includes('grid') ||
    lower.includes('through-the-years') ||
    lower.includes('evolution') ||
    lower.includes('timeline') ||
    lower.includes('then-and-now') ||
    lower.includes('before-after');
  
  return !isLikelyCollage;
}
