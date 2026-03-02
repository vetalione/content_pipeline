/**
 * Gemini Vision API for validating image relevance
 *
 * TWO MODES:
 *
 * 1. batchValidateImages() — NEW, preferred
 *    Sends up to BATCH_SIZE thumbnail images in ONE Gemini request.
 *    • Uses thumbnailUrl when available (5–30 KB) instead of originalUrl (500 KB–5 MB)
 *    • One Gemini call per batch of 4 → ~4× fewer API calls
 *    Combined with thumbnails: ~30× lower cost + bandwidth than the old approach.
 *
 * 2. findBestImage() — legacy, kept for backward compatibility / fallback
 *    Validates images one by one; still uses thumbnailUrl when present.
 *
 * Optimizations shared by both:
 * - Retry with exponential backoff for failed fetches
 * - Early exit when high-confidence match found
 */

import { GoogleGenAI } from '@google/genai';

interface ImageValidationResult {
  isRelevant: boolean;
  confidence: number; // 0-100
  reasoning: string;
}

// Configuration
const MAX_CONCURRENT_VALIDATIONS = 3;
const EARLY_EXIT_THRESHOLD = 85; // Stop searching when we find 85%+ match
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch image with retry and exponential backoff
 */
async function fetchImageWithRetry(
  imageUrl: string,
  maxRetries: number = MAX_RETRIES
): Promise<{ buffer: ArrayBuffer; mimeType: string } | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(10000) // 10 second timeout per attempt
      });

      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          // Don't retry client errors
          return null;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const mimeType = response.headers.get('content-type') || 'image/jpeg';
      
      return { buffer, mimeType };
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      
      if (isLastAttempt) {
        console.log(`    ⚠️ Fetch failed after ${maxRetries + 1} attempts: ${error.message}`);
        return null;
      }
      
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
      console.log(`    🔄 Retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
      await sleep(delay);
    }
  }
  return null;
}

/**
 * Validate if image shows the celebrity and matches the description
 * Uses retry with exponential backoff for image fetching
 */
export async function validateImageRelevance(
  imageUrl: string,
  celebrityName: string,
  description: string
): Promise<ImageValidationResult> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  
  if (!apiKey) {
    return {
      isRelevant: true,
      confidence: 50,
      reasoning: 'API key not configured'
    };
  }

  try {
    // Fetch image with retry logic
    const imageData = await fetchImageWithRetry(imageUrl);
    
    if (!imageData) {
      return {
        isRelevant: false,
        confidence: 0,
        reasoning: 'Image fetch failed'
      };
    }

    const genAI = new GoogleGenAI({ apiKey });

    const base64Image = Buffer.from(imageData.buffer).toString('base64');

    // Prompt that REQUIRES the celebrity to be in the photo
    // IMPORTANT: "confidence" = how SUITABLE the image is, NOT how sure you are about your answer
    const prompt = `You are an image validator for a biography article about "${celebrityName}".

TASK: Rate how SUITABLE this image is for the article (0-100 score).

TOPIC/SCENE we need: "${description}"

SCORING RULES (confidence = SUITABILITY score, NOT your certainty):
- 85-100: "${celebrityName}" is clearly visible + matches the topic + high quality single photo
- 70-84: "${celebrityName}" is visible + partially matches topic
- 55-69: "${celebrityName}" is visible but generic photo
- 40-54: Might be "${celebrityName}" but hard to confirm
- 20-39: Wrong person or poor quality
- 0-19: "${celebrityName}" is NOT in the image AT ALL (illustration, wrong person, stock photo)

CRITICAL: If "${celebrityName}" is NOT visible in the image → score MUST be 0-19!
- Random illustrations, graphics, book covers without the person = 0-10%
- Stock photos of other people = 0-10%
- Photos of different celebrities = 0-10%

QUALITY PENALTIES (subtract from score):
- Collage/grid of multiple photos: -20%
- Blurry/compressed: -15%
- Face cropped off: -15%
- Large watermarks: -10%

OUTPUT FORMAT (JSON only, no other text):
{"isRelevant": true/false, "confidence": 0-100, "reasoning": "one sentence"}

REMEMBER: "confidence" = how GOOD this image is for the article, NOT how sure you are!`;

    const result = await genAI.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { data: base64Image, mimeType: imageData.mimeType } },
          { text: prompt }
        ]
      }]
    });

    const response = result.text ?? '';
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('Invalid JSON response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as ImageValidationResult;
    
    // SAFETY CHECK: If reasoning says celebrity is NOT visible but confidence is high, fix it
    const reasoning = (parsed.reasoning || '').toLowerCase();
    const celebrityLower = celebrityName.toLowerCase();
    
    const negativeIndicators = [
      'not visible', 'not in', 'cannot identify', 'not a photograph of',
      'does not contain', 'does not show', 'not present', 'is not', 
      'wrong person', 'different person', 'no photo of', 'not the',
      'illustration', 'graphic', 'cartoon', 'drawing', 'not a photo'
    ];
    
    const hasNegativeIndicator = negativeIndicators.some(neg => reasoning.includes(neg));
    
    if (hasNegativeIndicator && parsed.confidence > 30) {
      console.log(`    ⚠️ Safety override: reasoning says NO but confidence was ${parsed.confidence}%, setting to 0%`);
      parsed.confidence = 0;
      parsed.isRelevant = false;
    }
    
    return parsed;

  } catch (error) {
    return {
      isRelevant: true,
      confidence: 40,
      reasoning: `Error: ${error instanceof Error ? error.message : 'Unknown'}`
    };
  }
}

/**
 * Process items with limited concurrency and early exit support
 */
async function processWithConcurrency<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  maxConcurrent: number,
  earlyExitCheck?: (result: R) => boolean
): Promise<{ results: R[]; earlyExitResult?: R }> {
  const results: R[] = [];
  let currentIndex = 0;
  let earlyExitResult: R | undefined;
  let stopped = false;

  async function processNext(): Promise<void> {
    while (!stopped && currentIndex < items.length) {
      const index = currentIndex++;
      const item = items[index];
      
      const result = await processor(item, index);
      
      if (stopped) return; // Another worker found early exit
      
      results.push(result);
      
      if (earlyExitCheck && earlyExitCheck(result)) {
        stopped = true;
        earlyExitResult = result;
        console.log(`  🎯 Early exit: found high-confidence match!`);
      }
    }
  }

  const workers = Array(Math.min(maxConcurrent, items.length))
    .fill(null)
    .map(() => processNext());

  await Promise.all(workers);
  
  return { results, earlyExitResult };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch validation (NEW — preferred path)
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 4; // images per Gemini request

export interface BatchValidationResult {
  /** 0-based index into the input candidates array */
  bestIndex: number;
  confidence: number;   // 0–100
  reasoning: string;
  /** per-image scores, same order as input */
  scores: number[];
}

/**
 * Validate up to BATCH_SIZE image candidates in a SINGLE Gemini request.
 *
 * BANDWIDTH STRATEGY:
 *   For each candidate we fetch `thumbnailUrl` if present (5–30 KB each),
 *   otherwise fall back to `originalUrl`.  This cuts transfer size by ~95 %
 *   compared to always fetching full originals.
 *
 * COST STRATEGY:
 *   Small images (≤ 384 px) cost only 258 tokens each in Gemini.
 *   4 thumbnails = ~1 032 tokens vs. 4 separate full-image calls = ~16 000 tokens.
 *
 * Returns null when no images can be fetched or Gemini fails.
 */
export async function batchValidateImages(
  candidates: Array<{ originalUrl: string; thumbnailUrl?: string }>,
  celebrityName: string,
  description: string,
  factYear?: number,
): Promise<BatchValidationResult | null> {
  if (candidates.length === 0) return null;

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    // Fallback: return first candidate at 50% confidence so pipeline doesn't break
    return { bestIndex: 0, confidence: 50, reasoning: 'API key not configured', scores: candidates.map(() => 50) };
  }

  const batch = candidates.slice(0, BATCH_SIZE);

  // ── Fetch all thumbnails in parallel ──────────────────────────────────────
  const fetchedImages = await Promise.all(
    batch.map(async (c) => {
      // Use thumbnail when available — much smaller download
      const urlToFetch = c.thumbnailUrl ?? c.originalUrl;
      const imgData = await fetchImageWithRetry(urlToFetch);
      return imgData; // null on failure
    })
  );

  // Only keep candidates where the image was successfully fetched
  const validPairs = batch
    .map((c, i) => ({ candidate: c, imgData: fetchedImages[i], index: i }))
    .filter((p): p is typeof p & { imgData: NonNullable<typeof p.imgData> } => p.imgData !== null);

  if (validPairs.length === 0) {
    console.log('  ❌ Batch: no images could be fetched');
    return null;
  }

  try {
    // Use flash — cheapest model, thumbnails don't need pro-level vision
    const genAI = new GoogleGenAI({ apiKey });

    // Build multi-image prompt parts
    const parts: any[] = [];

    // Era context line — injected when we know the fact year.
    // This is the key editorial signal: a blurry b&w photo from 1965 is MORE
    // VALUABLE than a perfect 2020 studio headshot for a fact set in 1965.
    const eraLine = factYear
      ? `\nEra: this section describes events from circa ${factYear}. Photos visually matching that era are MORE VALUABLE (add 10 pts).`
      : '';

    const eraPenalty = factYear && factYear < 2000
      ? `\nPENALTY: Deduct 15 pts if the photo is clearly a modern (post-2010) promotional/studio shot — it is wrong for a ${factYear} context.`
      : '';

    const intro = `You are validating photos for a RARE BIOGRAPHICAL article.
Celebrity: "${celebrityName}"
Section: "${description}"${eraLine}${eraPenalty}

I'm showing you ${validPairs.length} image(s) numbered 1–${validPairs.length}.
Score EACH from 0–100:
  85–100 : "${celebrityName}" is clearly visible + matches context${factYear ? ` + visually era-appropriate (~${factYear})` : ''}
  65–84  : "${celebrityName}" is visible, partial match or uncertain era
  40–64  : Might be "${celebrityName}", unclear
  0–39   : Wrong person, stock art, illustration, OR "${celebrityName}" NOT visible${factYear ? `, OR clearly wrong era` : ''}

BONUS +10: Photo is visually archival/historical (b&w, aged, newspaper scan, documentary style).
PENALIZE: collage/grid of multiple photos (−20), face cropped off (−15), large watermark (−10).

OUTPUT ONLY valid JSON (no markdown):
{"scores":[85,10,40],"best":0,"reasoning":"one sentence about the winner"}`;

    parts.push({ text: intro });

    for (let i = 0; i < validPairs.length; i++) {
      const { imgData } = validPairs[i];
      parts.push({ text: `\nImage ${i + 1}:` });
      parts.push({ inlineData: { data: Buffer.from(imgData.buffer).toString('base64'), mimeType: imgData.mimeType } });
    }

    const result = await genAI.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [{ role: 'user', parts }]
    });
    const responseText = result.text ?? '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]) as { scores: number[]; best: number; reasoning: string };

    // Map back to original indices (some images may have failed to fetch)
    const fullScores = batch.map((_, i) => {
      const validIdx = validPairs.findIndex(p => p.index === i);
      return validIdx >= 0 ? (parsed.scores[validIdx] ?? 0) : 0;
    });

    const bestLocalIdx = parsed.best ?? fullScores.indexOf(Math.max(...fullScores));
    const bestOriginalIdx = validPairs[bestLocalIdx]?.index ?? 0;
    const bestScore = fullScores[bestOriginalIdx] ?? 0;

    console.log(`  🎯 Batch result (${validPairs.length} images): scores=${JSON.stringify(fullScores)}, best=[${bestOriginalIdx}] ${bestScore}%`);
    console.log(`  💬 ${parsed.reasoning}`);

    return {
      bestIndex: bestOriginalIdx,
      confidence: bestScore,
      reasoning: parsed.reasoning,
      scores: fullScores,
    };
  } catch (error: any) {
    console.error('  ❌ Batch Gemini validation error:', error.message);
    return null;
  }
}

/**
 * Find best image from multiple candidates using Gemini validation
 * Uses limited parallelism (3 concurrent) and early-exit at threshold confidence
 * Returns detailed result with confidence and reasoning
 */
export async function findBestImage(
  imageUrls: string[],
  celebrityName: string,
  description: string,
  onProgress?: (progress: { stage: string; current: number; total: number; confidence?: number }) => void,
  sources?: Array<'google-en' | 'google-ru' | 'brave' | 'perplexity'>,
  confidenceThreshold: number = 85
): Promise<FindBestImageResult | null> {
  if (imageUrls.length === 0) {
    return null;
  }

  console.log(`  🔍 Validating ${imageUrls.length} candidates (max ${MAX_CONCURRENT_VALIDATIONS} parallel, early-exit at ${confidenceThreshold}%)...`);
  
  let processedCount = 0;
  
  const { results, earlyExitResult } = await processWithConcurrency(
    imageUrls,
    async (url, index) => {
      const shortUrl = url.length > 60 ? url.substring(0, 60) + '...' : url;
      const source = sources?.[index] || 'unknown';
      console.log(`  📸 [${index + 1}/${imageUrls.length}] [${source}] ${shortUrl}`);
      
      const validation = await validateImageRelevance(url, celebrityName, description);
      
      processedCount++;
      
      // Report progress
      if (onProgress) {
        onProgress({
          stage: 'validating',
          current: processedCount,
          total: imageUrls.length,
          confidence: validation.confidence
        });
      }
      
      const icon = validation.confidence >= confidenceThreshold ? '🎯' :
                   validation.confidence >= 70 ? '✅' :
                   validation.confidence >= 50 ? '⚠️' : '❌';
      console.log(`  ${icon} [${index + 1}] [${source}] ${validation.confidence}% - ${validation.reasoning}`);
      
      return { url, validation, source };
    },
    MAX_CONCURRENT_VALIDATIONS,
    (result) => result.validation.confidence >= confidenceThreshold
  );

  // If early exit found a great match, use it
  if (earlyExitResult) {
    console.log(`  ✅ Using early-exit match from ${earlyExitResult.source} (${earlyExitResult.validation.confidence}%)`);
    if (onProgress) {
      onProgress({
        stage: 'found',
        current: imageUrls.length,
        total: imageUrls.length,
        confidence: earlyExitResult.validation.confidence
      });
    }
    return { url: earlyExitResult.url, confidence: earlyExitResult.validation.confidence, reasoning: earlyExitResult.validation.reasoning };
  }

  // Otherwise find best from all checked
  const validResults = results.filter(r => r.validation.confidence > 0);
  
  if (validResults.length === 0) {
    console.log(`  ❌ No valid images found`);
    return null;
  }

  const best = validResults.reduce((a, b) => 
    a.validation.confidence > b.validation.confidence ? a : b
  );

  console.log(`  🏆 Best match from ${best.source}: ${best.validation.confidence}% - ${best.validation.reasoning}`);
  
  return { url: best.url, confidence: best.validation.confidence, reasoning: best.validation.reasoning };
}

export interface FindBestImageResult {
  url: string;
  confidence: number;
  reasoning: string;
}
