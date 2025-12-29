/**
 * Gemini Vision API for validating image relevance
 * Checks if image matches the description and shows the correct person
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

interface ImageValidationResult {
  isRelevant: boolean;
  confidence: number; // 0-100
  reasoning: string;
}

/**
 * Validate if image shows the celebrity and matches the description
 * @param imageUrl Direct URL to the image
 * @param celebrityName Name of the person who should be in the image
 * @param description What the image should show
 * @returns Validation result with confidence score
 */
export async function validateImageRelevance(
  imageUrl: string,
  celebrityName: string,
  description: string
): Promise<ImageValidationResult> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  
  if (!apiKey) {
    console.warn('⚠️ GOOGLE_GEMINI_API_KEY not configured, skipping image validation');
    return {
      isRelevant: true, // Default to true if no validation possible
      confidence: 50,
      reasoning: 'API key not configured'
    };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Fetch image as base64 (no timeout - let it take the time it needs)
    let imageResponse: Response;
    try {
      imageResponse = await fetch(imageUrl, { 
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
    } catch (fetchError: any) {
      console.log(`  ⚠️ Image fetch error: ${fetchError.message}`);
      return {
        isRelevant: false,
        confidence: 0,
        reasoning: 'Image fetch failed'
      };
    }
    
    if (!imageResponse.ok) {
      // Image not accessible (403, 404, etc.) - skip validation
      console.log(`  ⚠️ Image not accessible (${imageResponse.status}): ${imageUrl.substring(0, 60)}...`);
      return {
        isRelevant: false,
        confidence: 0,
        reasoning: `Image not accessible: ${imageResponse.status}`
      };
    }
    
    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');
    const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

    // Prepare prompt for Gemini
    const prompt = `Проанализируй это изображение и ответь на вопросы:

1. Есть ли на изображении человек по имени "${celebrityName}"?
2. Соответствует ли изображение описанию: "${description}"?

Оцени релевантность изображения от 0 до 100, где:
- 100 = идеально соответствует (виден ${celebrityName} и контекст совпадает)
- 70-99 = виден ${celebrityName}, но контекст частично отличается
- 50-69 = похоже на ${celebrityName}, но неуверенность
- 0-49 = не ${celebrityName} или совсем не соответствует

Ответь СТРОГО в JSON формате:
{
  "isRelevant": true/false (true если score >= 70),
  "confidence": число от 0 до 100,
  "reasoning": "краткое объяснение на русском"
}`;

    // Call Gemini API without timeout - let it take the time it needs for thorough validation
    const result = await model.generateContent([
      {
        inlineData: {
          data: base64Image,
          mimeType
        }
      },
      { text: prompt }
    ]);

    const response = result.response.text();
    console.log(`🤖 Gemini validation response:`, response.substring(0, 200));

    // Parse JSON response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid JSON response from Gemini');
    }

    const validation: ImageValidationResult = JSON.parse(jsonMatch[0]);
    
    console.log(`  📊 Validation: ${validation.isRelevant ? '✅' : '❌'} (${validation.confidence}%) - ${validation.reasoning}`);
    
    return validation;

  } catch (error) {
    console.error('Gemini image validation error:', error);
    // On error, default to accepting the image
    return {
      isRelevant: true,
      confidence: 50,
      reasoning: `Validation error: ${error instanceof Error ? error.message : 'Unknown'}`
    };
  }
}

/**
 * Find best image from multiple candidates using Gemini validation
 * Validates ALL images in parallel and picks the best one (no shortcuts)
 * @param imageUrls Array of candidate image URLs
 * @param celebrityName Name of the person
 * @param description What the image should show
 * @returns Best matching image URL or null
 */
export async function findBestImage(
  imageUrls: string[],
  celebrityName: string,
  description: string
): Promise<string | null> {
  if (imageUrls.length === 0) {
    return null;
  }

  console.log(`  🔍 Validating ALL ${imageUrls.length} image candidates with Gemini (thorough mode)...`);

  // Validate ALL images in parallel - no shortcuts, check everything
  const validations = await Promise.all(
    imageUrls.map(async (url, index) => {
      console.log(`  📸 [${index + 1}/${imageUrls.length}] Checking: ${url.substring(0, 70)}...`);
      const validation = await validateImageRelevance(url, celebrityName, description);
      console.log(`  📊 [${index + 1}/${imageUrls.length}] Result: ${validation.isRelevant ? '✅' : '❌'} confidence=${validation.confidence}% - ${validation.reasoning}`);
      return { url, validation };
    })
  );

  // Sort by confidence descending
  const sortedByConfidence = validations
    .filter(v => v.validation.confidence > 0) // Remove failed fetches
    .sort((a, b) => b.validation.confidence - a.validation.confidence);

  if (sortedByConfidence.length === 0) {
    console.log(`  ❌ All validations failed (fetch errors)`);
    return null;
  }

  // Log top 3 candidates
  console.log(`  🏆 Top candidates:`);
  sortedByConfidence.slice(0, 3).forEach((v, i) => {
    console.log(`     ${i + 1}. [${v.validation.confidence}%] ${v.url.substring(0, 60)}...`);
  });

  // Return best match (highest confidence)
  const best = sortedByConfidence[0];
  
  if (best.validation.confidence >= 70) {
    console.log(`  ✅ EXCELLENT match found (${best.validation.confidence}%): ${best.validation.reasoning}`);
  } else if (best.validation.confidence >= 50) {
    console.log(`  ⚠️ ACCEPTABLE match found (${best.validation.confidence}%): ${best.validation.reasoning}`);
  } else {
    console.log(`  ⚠️ WEAK match (${best.validation.confidence}%) - best available: ${best.validation.reasoning}`);
  }

  return best.url;
}
