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

    // Compact prompt for faster response
    const prompt = `Analyze image. Is "${celebrityName}" in it? Match: "${description}"?

Score 0-100:
- 85-100: Person confirmed, context matches
- 70-84: Person likely, partial match  
- 50-69: Uncertain
- 0-49: Wrong/no match

JSON only: {"isRelevant": bool, "confidence": num, "reasoning": "brief"}`;

    const result = await model.generateContent([
      { inlineData: { data: base64Image, mimeType: imageData.mimeType } },
      { text: prompt }
    ]);

    const response = result.response.text();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('Invalid JSON response');
    }

    return JSON.parse(jsonMatch[0]) as ImageValidationResult;

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
 * Uses limited parallelism (3 concurrent) and early-exit at 85% confidence
 */
export async function findBestImage(
  imageUrls: string[],
  celebrityName: string,
  description: string
): Promise<string | null> {
  if (imageUrls.length === 0) {
    return null;
  }

  console.log(`  🔍 Validating ${imageUrls.length} candidates (max ${MAX_CONCURRENT_VALIDATIONS} parallel, early-exit at ${EARLY_EXIT_THRESHOLD}%)...`);

  const { results, earlyExitResult } = await processWithConcurrency(
    imageUrls,
    async (url, index) => {
      const shortUrl = url.length > 60 ? url.substring(0, 60) + '...' : url;
      console.log(`  📸 [${index + 1}/${imageUrls.length}] ${shortUrl}`);
      
      const validation = await validateImageRelevance(url, celebrityName, description);
      
      const icon = validation.confidence >= EARLY_EXIT_THRESHOLD ? '🎯' :
                   validation.confidence >= 70 ? '✅' :
                   validation.confidence >= 50 ? '⚠️' : '❌';
      console.log(`  ${icon} [${index + 1}] ${validation.confidence}% - ${validation.reasoning}`);
      
      return { url, validation };
    },
    MAX_CONCURRENT_VALIDATIONS,
    (result) => result.validation.confidence >= EARLY_EXIT_THRESHOLD
  );

  // If early exit found a great match, use it
  if (earlyExitResult) {
    console.log(`  ✅ Using early-exit match (${earlyExitResult.validation.confidence}%)`);
    return earlyExitResult.url;
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

  console.log(`  🏆 Best match: ${best.validation.confidence}% - ${best.validation.reasoning}`);
  
  return best.url;
}
