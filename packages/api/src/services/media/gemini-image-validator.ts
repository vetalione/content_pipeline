/**
 * Gemini Vision API for validating image relevance
 * Checks if image matches the description and shows the correct person
 * 
 * Optimizations:
 * - Retry with exponential backoff for failed fetches
 * - Limited parallelism (max 3 concurrent validations)
 * - Early exit when high-confidence match found
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

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

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

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

    const result = await model.generateContent([
      { inlineData: { data: base64Image, mimeType: imageData.mimeType } },
      { text: prompt }
    ]);

    const response = result.response.text();
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
