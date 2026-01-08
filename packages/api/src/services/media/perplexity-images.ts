/**
 * Perplexity Sonar Pro API for finding images
 * Uses AI-powered search for better contextual matches
 */

interface PerplexityImageResult {
  image_url?: string;
  origin_url?: string;
  url?: string;
}

/**
 * Search for images using Perplexity Sonar Pro API
 * @param query Search query describing what image to find
 * @param numResults Number of results to return
 * @returns Array of direct image URLs
 */
export async function searchPerplexityImages(
  query: string,
  numResults: number = 5
): Promise<string[]> {
  const apiKey = process.env.PERPLEXITY_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ Perplexity not configured (PERPLEXITY_API_KEY missing)');
    return [];
  }

  try {
    console.log(`�� Perplexity Image Search: "${query}"`);

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'system',
            content: 'You are an image search assistant. Find the most relevant historical photos. Return ONLY valid direct image URLs (ending in .jpg, .jpeg, .png). Prioritize Wikipedia, Wikimedia Commons, and archive.org sources.'
          },
          {
            role: 'user',
            content: `Find ${numResults} high-quality photos for: "${query}". Return ONLY the direct image URLs, one per line. No explanations.`
          }
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
          '-alamy.com'
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
    
    console.log(`✅ Perplexity found ${result.length} images for: "${query}"`);
    return result;

  } catch (error) {
    console.error('Perplexity Image Search error:', error);
    return [];
  }
}

/**
 * Check if URL is a valid direct image URL (not stock photo)
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
  
  return !isStockPhoto;
}
