/**
 * Perplexity Sonar Pro API for finding images
 *
 * Returns ImageCandidate[] — same shape as other sources.
 *
 * Perplexity does NOT return separate thumbnail URLs (unlike Google/Brave).
 * However it frequently returns Wikimedia Commons URLs, which support a
 * built-in resize parameter:
 *   Original: .../commons/thumb/a/ab/Photo.jpg/800px-Photo.jpg
 *   Thumbnail: .../commons/thumb/a/ab/Photo.jpg/300px-Photo.jpg
 * We exploit this to construct thumbnailUrl for Wikimedia results — free,
 * no extra request needed.
 *
 * For non-Wikimedia URLs we set thumbnailUrl = undefined, meaning Gemini
 * batch-validation will fetch the original (but those are usually smaller
 * news-agency JPEGs, not multi-MB stock photos).
 */

import { type ImageCandidate, scoreByMetadata } from './google-images';

interface PerplexityImageItem {
  image_url?: string;
  origin_url?: string;
  url?: string;
}

/**
 * Try to build a ~300px thumbnail URL from a Wikimedia Commons image URL.
 * Returns undefined for non-Wikimedia URLs.
 *
 * Wikimedia resize URL pattern:
 *   .../thumb/{hash}/{file}.jpg/{N}px-{file}.jpg
 * We simply replace the size prefix, e.g. "800px" → "300px".
 */
function wikimediaThumbnail(imageUrl: string): string | undefined {
  // Must be a Wikimedia /thumb/ URL
  if (!imageUrl.includes('upload.wikimedia.org') || !imageUrl.includes('/thumb/')) {
    return undefined;
  }
  // Replace any existing Npx- size prefix with 300px
  return imageUrl.replace(/\/\d+px-/, '/300px-');
}

const systemPrompt = `You are an expert archivist photo researcher for a biographical article series about celebrity failures and rare life moments.

ARTICLE CONCEPT: We write articles showing the HIDDEN side of famous people — childhood poverty, failures, arrests, bankruptcies, early struggles. We need RARE, ARCHIVAL photographs that visually match those specific moments — NOT the well-known mainstream images that appear everywhere.

YOUR TASK: Find RARE HISTORICAL photographs matching the user's description.

PRIORITY SOURCES (use these first — in order):
1. Wikimedia Commons (commons.wikimedia.org) — historical archive with era-specific photos
2. Archive.org — digitized newspapers, books, historic photo collections
3. Newspapers.com / ChroniclingAmerica — historical newspaper photos
4. News agency archives: AP, Reuters, AFP, UPI, TASS (if publicly accessible)
5. Museum digital collections, government archives (loc.gov, nara.gov)
6. University library archives

AVOID THESE (they give mainstream, overused photos):
- wikipedia.org MAIN ARTICLE (returns the single most famous headshot — wrong for rare content)
- Getty Images, Shutterstock, Alamy, iStock (paid, mainstream)
- Pinterest, Instagram (aggregators, not originals)
- Collages / "through the years" compilations
- Modern promotional/studio shots (unless the context is modern)
- Stock photo sites of any kind

RARITY CRITERIA (what makes a photo valuable for our articles):
✅ Era-appropriate: visually matches the decade/year described
✅ Documentary/candid style — not a posed studio portrait
✅ Shows the person in a specific context (at work, in difficulty, in early career)
✅ Black & white or aged photos for historical contexts = HIGHLY VALUED
✅ One clear photo of the person (not a collage)
❌ Modern crisp promotional headshots for historical facts = WRONG
❌ Always-seen mainstream portraits = low value for our content

OUTPUT FORMAT:
Return ONLY direct image URLs (ending in .jpg, .jpeg, .png), one per line.
No explanations or descriptions.`;

/**
 * Search for images using Perplexity Sonar Pro API.
 *
 * @param query        Full descriptive query (visual suggestion + context)
 * @param numResults   Number of results to return
 * @param celebrityName Used for metadata scoring
 * @param year         Target year for the photo
 */
export async function searchPerplexityImages(
  query: string,
  numResults: number = 5,
  celebrityName?: string,
  year?: number
): Promise<ImageCandidate[]> {
  const apiKey = process.env.PERPLEXITY_API_KEY;

  if (!apiKey) {
    console.warn('⚠️ Perplexity not configured (PERPLEXITY_API_KEY missing)');
    return [];
  }

  try {
    let searchContext = query;
    if (celebrityName && !query.toLowerCase().includes(celebrityName.toLowerCase())) {
      searchContext = `${celebrityName}: ${query}`;
    }
    if (year && !query.includes(String(year))) {
      searchContext += ` (circa ${year})`;
    }

    console.log(`🔮 Perplexity AI Search: "${searchContext.substring(0, 80)}..."`);

    const userPrompt = `Find ${numResults} authentic photographs matching this description:\n\n"${searchContext}"\n\nReturn only direct image URLs, one per line.`;

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
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
          '-depositphotos.com',
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Perplexity API error: ${response.status} - ${errorText}`);
      return [];
    }

    const data: any = await response.json();

    const rawImages: Array<{ imageUrl: string; originUrl?: string }> = [];

    // Method 1: data.images array
    if (data.images && Array.isArray(data.images)) {
      for (const img of data.images) {
        let imageUrl: string | undefined;
        let originUrl: string | undefined;

        if (typeof img === 'string') {
          imageUrl = img;
        } else if (img && typeof img === 'object') {
          imageUrl = img.image_url ?? img.url ?? img.src;
          originUrl = img.origin_url;
        }

        if (imageUrl && isValidImageUrl(imageUrl)) {
          rawImages.push({ imageUrl, originUrl });
        }
      }
    }

    // Method 2: parse URLs from text response
    const content = data.choices?.[0]?.message?.content ?? '';
    const urlMatches = content.match(/https?:\/\/[^\s"'<>]+\.(jpg|jpeg|png)(\?[^\s"'<>]*)?/gi) as string[] | null;
    if (urlMatches) {
      for (const url of urlMatches) {
        if (isValidImageUrl(url) && !rawImages.some(r => r.imageUrl === url)) {
          rawImages.push({ imageUrl: url });
        }
      }
    }

    const candidates: ImageCandidate[] = rawImages
      .slice(0, numResults)
      .map(({ imageUrl, originUrl }) => {
        const candidate: ImageCandidate = {
          originalUrl: imageUrl,
          // Construct a Wikimedia thumbnail when possible (free resize, no extra request)
          thumbnailUrl: wikimediaThumbnail(imageUrl),
          sourceUrl: originUrl,
          source: 'perplexity',
          metadataScore: 0,
        };
        candidate.metadataScore = scoreByMetadata(
          { originalUrl: imageUrl, sourceUrl: originUrl },
          celebrityName ?? '',
          year, // temporal scoring: archive.org/commons photos matching the year rank higher
        );
        return candidate;
      });

    console.log(`✅ Perplexity found ${candidates.length} candidates`);
    return candidates;

  } catch (error) {
    console.error('Perplexity Image Search error:', error);
    return [];
  }
}

function isValidImageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  const hasImageExt =
    lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') ||
    lower.includes('.jpg?') || lower.includes('.jpeg?') || lower.includes('.png?');
  if (!hasImageExt) return false;

  const isStock =
    lower.includes('gettyimages') || lower.includes('shutterstock') ||
    lower.includes('istockphoto') || lower.includes('alamy') ||
    lower.includes('dreamstime') || lower.includes('depositphotos') ||
    lower.includes('pinterest');
  if (isStock) return false;

  const isCollage =
    lower.includes('collage') || lower.includes('grid') ||
    lower.includes('through-the-years') || lower.includes('timeline') ||
    lower.includes('then-and-now') || lower.includes('before-after');

  return !isCollage;
}
