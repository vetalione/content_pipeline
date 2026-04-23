/**
 * OpenAI Responses API + web_search tool for finding archival photos.
 *
 * Unlike OpenAI's image *generation* API (gpt-image-2), this file uses GPT-5
 * with the built-in `web_search` tool to locate existing real photographs
 * on the internet and return direct image URLs as JSON.
 *
 * This approximates what ChatGPT.com does when you ask it to find photos
 * (it browses the web, scrapes image URLs from pages, and surfaces them).
 * The public API does not expose ChatGPT's internal image-search panel, so
 * we instruct the model to return a structured list of direct image URLs.
 *
 * Output shape matches all other image sources (ImageCandidate[]), so the
 * result feeds straight into the existing ranking + Gemini validation +
 * dedup pipeline in google-images.ts.
 */

import { type ImageCandidate, scoreByMetadata } from './google-images';

/**
 * Try to build a ~300px thumbnail URL from a Wikimedia Commons image URL.
 * (Same trick as perplexity-images.ts — zero-cost thumbnail for the
 * Gemini validator so it doesn't download multi-MB originals.)
 */
function wikimediaThumbnail(imageUrl: string): string | undefined {
  if (!imageUrl.includes('upload.wikimedia.org') || !imageUrl.includes('/thumb/')) {
    return undefined;
  }
  return imageUrl.replace(/\/\d+px-/, '/300px-');
}

function isValidImageUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  // Require a common image extension somewhere in the path (query string allowed).
  return /\.(jpe?g|png|webp)(\?|$|#)/i.test(url);
}

const SYSTEM_PROMPT = `You are a professional photo researcher for a biographical article series about celebrity failures and rare life moments.

TASK: Use the web_search tool to find RARE, ARCHIVAL photographs matching the user's description. Extract direct image URLs (.jpg / .jpeg / .png / .webp) from the web pages you visit.

PRIORITY SOURCES (use these first):
1. commons.wikimedia.org — historical archive, era-appropriate photos
2. archive.org — digitized books, newspapers, photo collections
3. loc.gov, nara.gov — US government archives
4. newspapers.com, chroniclingamerica.loc.gov — historical newspapers
5. museum / university digital collections
6. News agency archives (AP, Reuters, AFP, UPI, TASS) where publicly accessible

AVOID:
- wikipedia.org MAIN ARTICLE headshots (too mainstream; same photo everyone uses)
- gettyimages.com, shutterstock.com, alamy.com, istockphoto.com, dreamstime.com
- pinterest.com, instagram.com, facebook.com (aggregators, not originals)
- Collage / "through the years" / "then and now" compilations
- Modern promotional / studio shots when the context is historical

RARITY CRITERIA (what we want):
- Era-appropriate (the photo visually matches the described decade/year)
- Documentary / candid style — not a posed studio portrait
- Black & white or visibly aged for pre-1980 facts
- ONE person clearly visible — no collages
- Not the same photo that appears on the person's Wikipedia page

OUTPUT: Respond with ONLY a valid JSON object in this exact shape (no prose, no markdown fences):
{
  "images": [
    {
      "url": "https://direct.image.url/photo.jpg",
      "sourceUrl": "https://page-where-image-appears.com/article",
      "title": "Short descriptive title of the photo",
      "year": 1976
    }
  ]
}

Rules for the JSON:
- "url" MUST be a direct image URL ending in .jpg/.jpeg/.png/.webp (not an HTML page).
- "sourceUrl" is the page where you found the image (used for source attribution).
- Omit "year" if unknown.
- Return between 3 and 8 items. Favor fewer high-quality rare photos over many mainstream ones.`;

interface OpenAIImageItem {
  url?: string;
  sourceUrl?: string;
  title?: string;
  year?: number;
}

/**
 * Search for images via OpenAI GPT-5 + web_search.
 *
 * @param query        Full descriptive query (visual suggestion + context)
 * @param numResults   Target number of results
 * @param celebrityName Used for metadata scoring
 * @param year         Target year for the photo
 */
export async function searchOpenAIImages(
  query: string,
  numResults: number = 5,
  celebrityName?: string,
  year?: number
): Promise<ImageCandidate[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ OpenAI image-search not configured (OPENAI_API_KEY missing)');
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

    console.log(`🧠 OpenAI web_search for images: "${searchContext.substring(0, 80)}..."`);

    const userPrompt = `Find up to ${numResults} authentic archival photographs matching:\n\n"${searchContext}"\n\nReturn the JSON object described in the system prompt.`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90_000);

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // gpt-5 supports web_search and general-purpose reasoning. If this
        // alias is gated on some accounts the call will 404 — the caller
        // handles empty results gracefully.
        model: 'gpt-5',
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
        input: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`OpenAI web_search error ${response.status}: ${errorText.substring(0, 300)}`);
      return [];
    }

    const data: any = await response.json();

    // Collect all text output from the Responses API. The assistant message
    // lives under output[*].content[*].text (type 'output_text'). A fallback
    // is data.output_text (SDK helper field mirrored by some gateway builds).
    let fullText = '';
    if (typeof data?.output_text === 'string') {
      fullText = data.output_text;
    } else if (Array.isArray(data?.output)) {
      for (const item of data.output) {
        const contents = item?.content;
        if (Array.isArray(contents)) {
          for (const c of contents) {
            if (typeof c?.text === 'string') fullText += c.text + '\n';
          }
        }
      }
    }

    if (!fullText) {
      console.warn('⚠️ OpenAI web_search returned empty text');
      return [];
    }

    // Extract the JSON object from the model's text — it may be wrapped in a
    // ```json fence or contain other prose before/after despite instructions.
    const jsonMatch = fullText.match(/\{[\s\S]*"images"[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('⚠️ OpenAI web_search: no JSON block in response');
      return [];
    }

    let parsed: { images?: OpenAIImageItem[] };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (err: any) {
      console.warn('⚠️ OpenAI web_search: JSON parse failed:', err?.message);
      return [];
    }

    const items = Array.isArray(parsed?.images) ? parsed.images : [];
    const seen = new Set<string>();
    const candidates: ImageCandidate[] = [];

    for (const item of items) {
      const imageUrl = (item?.url ?? '').trim();
      if (!isValidImageUrl(imageUrl)) continue;
      const key = imageUrl.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const sourceUrl = (item?.sourceUrl ?? '').trim() || undefined;
      const title = (item?.title ?? '').trim() || undefined;

      const candidate: ImageCandidate = {
        originalUrl: imageUrl,
        thumbnailUrl: wikimediaThumbnail(imageUrl),
        title,
        sourceUrl,
        source: 'openai',
        metadataScore: 0,
      };
      candidate.metadataScore = scoreByMetadata(candidate, celebrityName ?? '', year);
      candidates.push(candidate);

      if (candidates.length >= numResults) break;
    }

    console.log(`🧠 OpenAI web_search: ${candidates.length} candidates`);
    return candidates;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      console.error('OpenAI web_search timed out (90s)');
    } else {
      console.error('OpenAI web_search error:', error?.message ?? error);
    }
    return [];
  }
}
