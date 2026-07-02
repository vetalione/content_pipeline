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
  // Spoof the Referer to the image's own origin — bypasses most hotlink protection
  let referer = '';
  try { referer = new URL(imageUrl).origin + '/'; } catch { /* ignore malformed URLs */ }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          ...(referer ? { 'Referer': referer } : {}),
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        if (response.status === 403 || response.status === 404 || response.status === 429) {
          // Don't retry client errors
          return null;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      // Validate the response is actually an image — some servers return HTML with 200 OK
      // (Gemini crashes if it receives HTML instead of image bytes)
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        console.log(`    ⚠️ Skipped non-image response (${contentType}): ${imageUrl.substring(0, 60)}`);
        return null;
      }

      const buffer = await response.arrayBuffer();
      return { buffer, mimeType: contentType };
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
  const apiKey = process.env.GEMINI_API_KEY;  // same key used by gemini-cover.ts
  
  if (!apiKey) {
    // LOUD failure — a silent 50% here used to make selection look random.
    console.error('❌ GEMINI_API_KEY is not set — image validation is DISABLED. Set it in the environment (Railway → Variables).');
    return {
      isRelevant: false,
      confidence: 0,
      reasoning: 'GEMINI_API_KEY not configured — validation unavailable'
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
    // Errors must NOT masquerade as a "mediocre but acceptable" photo.
    // conf=0 → the candidate can never win over a genuinely validated one.
    return {
      isRelevant: false,
      confidence: 0,
      reasoning: `Validation error: ${error instanceof Error ? error.message : 'Unknown'}`
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
  era: 'pre_photography' | 'photography' = 'photography',
): Promise<BatchValidationResult | null> {
  if (candidates.length === 0) return null;

  const apiKey = process.env.GEMINI_API_KEY;  // same key used by gemini-cover.ts
  if (!apiKey) {
    // LOUD failure — do NOT return fake 50% scores for images nobody looked at.
    // Unvalidated images competing with validated ones is what made selection
    // feel random. Callers treat null as "validation unavailable".
    console.error('❌ GEMINI_API_KEY is not set — batch image validation is DISABLED. Set it in the environment (Railway → Variables).');
    return null;
  }

  const batch = candidates.slice(0, BATCH_SIZE);

  // ── Fetch all thumbnails in parallel ──────────────────────────────────────
  const fetchedImages = await Promise.all(
    batch.map(async (c) => {
      // Try thumbnail first (5–30 KB vs 500 KB+).
      // If thumbnail 429s/fails, fall back to originalUrl — some CDNs rate-limit
      // their thumbnail endpoint but serve the original fine.
      const urlsToTry = [c.thumbnailUrl, c.originalUrl].filter((u): u is string => !!u);
      for (const url of urlsToTry) {
        const imgData = await fetchImageWithRetry(url);
        if (imgData) return imgData;
      }
      return null; // both failed
    })
  );

  // Only keep candidates where the image was successfully fetched
  const validPairs = batch
    .map((c, i) => ({ candidate: c, imgData: fetchedImages[i], index: i }))
    .filter((p): p is typeof p & { imgData: NonNullable<typeof p.imgData> } => p.imgData !== null);

  if (validPairs.length === 0) {
    // Nobody has SEEN these images — do not award them fake 50% scores that
    // let them beat genuinely validated candidates from other batches.
    // null = "this batch could not be validated"; the orchestrator moves on.
    console.log('  ⚠️ Batch: no images could be fetched — skipping batch (unvalidated images are never selected)');
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

    // Pre-photography figures (Aristotle, Pushkin, ...) have NO photos —
    // paintings, engravings, busts and statues are the CORRECT imagery and
    // must NOT be rejected as "illustration, not a photo".
    const isPrePhoto = era === 'pre_photography';

    const intro = isPrePhoto
      ? `You are validating images for a RARE BIOGRAPHICAL article about a HISTORICAL figure.
Subject: "${celebrityName}" — lived BEFORE photography existed.
Section: "${description}"${eraLine}

VALID imagery for this person: period paintings, portraits, engravings, lithographs, busts, statues, manuscript illustrations. Photographs of this person CANNOT exist — do NOT expect one.

I'm showing you ${validPairs.length} image(s) numbered 1–${validPairs.length}.
Score EACH from 0–100:
  85–100 : Clearly depicts "${celebrityName}" (recognizable/classical depiction) + matches the section context
  65–84  : Depicts "${celebrityName}", generic or uncertain context match
  40–64  : Might depict "${celebrityName}", unclear
  0–39   : Different person/subject, modern stock art, meme, movie still with an actor, unrelated scene

PENALIZE: collage/grid (−20), heavy watermark (−10), cartoonish modern illustration (−15).

OUTPUT ONLY valid JSON (no markdown):
{"scores":[85,10,40],"best":0,"reasoning":"one sentence about the winner"}`
      : `You are validating photos for a RARE BIOGRAPHICAL article.
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

    // Retry up to 3 times for transient Gemini errors (503 service unavailable, 429 rate limit)
    let lastError: any;
    let responseText = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await genAI.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: [{ role: 'user', parts }]
        });
        responseText = result.text ?? '';
        break; // success
      } catch (e: any) {
        lastError = e;
        const msg = String(e?.message ?? e);
        const isTransient = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        if (!isTransient || attempt === 2) throw e;
        const delay = 2000 * (attempt + 1);
        console.log(`  🔄 Gemini transient error (${msg.substring(0, 60)}), retrying in ${delay}ms...`);
        await sleep(delay);
      }
    };
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
    const msg = String(error?.message ?? error);
    // Make key problems unmissable in Railway logs — an expired/invalid key
    // previously degraded silently into random-looking selection.
    if (msg.includes('API_KEY_INVALID') || msg.includes('API key not valid') || msg.includes('PERMISSION_DENIED') || msg.includes('401') || msg.includes('403')) {
      console.error('❌ GEMINI_API_KEY is INVALID or lacks permissions — image validation is failing. Rotate the key in Railway → Variables.');
    }
    console.error('  ❌ Batch Gemini validation error:', msg);
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
