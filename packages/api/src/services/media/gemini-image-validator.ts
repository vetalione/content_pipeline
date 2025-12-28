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
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Fetch image as base64
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.status}`);
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

  console.log(`  🔍 Validating ${imageUrls.length} image candidates with Gemini...`);

  // Validate each image
  const validations = await Promise.all(
    imageUrls.map(async (url) => ({
      url,
      validation: await validateImageRelevance(url, celebrityName, description)
    }))
  );

  // Filter relevant images (confidence >= 70)
  const relevantImages = validations
    .filter(v => v.validation.isRelevant && v.validation.confidence >= 70)
    .sort((a, b) => b.validation.confidence - a.validation.confidence);

  if (relevantImages.length > 0) {
    const best = relevantImages[0];
    console.log(`  ✅ Best image: ${best.url} (confidence: ${best.validation.confidence}%)`);
    return best.url;
  }

  // If no highly relevant images, take the best available (if confidence > 50)
  const acceptable = validations
    .filter(v => v.validation.confidence > 50)
    .sort((a, b) => b.validation.confidence - a.validation.confidence);

  if (acceptable.length > 0) {
    const best = acceptable[0];
    console.log(`  ⚠️ Acceptable image: ${best.url} (confidence: ${best.validation.confidence}%)`);
    return best.url;
  }

  console.log(`  ❌ No relevant images found`);
  return null;
}
