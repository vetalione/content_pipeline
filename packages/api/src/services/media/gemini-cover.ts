import { GoogleGenAI } from '@google/genai';
import { promises as fs } from 'fs';
import path from 'path';

// Lazy initialization - will be created on first use with actual env var value
let genAI: GoogleGenAI | null = null;

function getGenAI(): GoogleGenAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
    console.log('🔑 Initializing Gemini client with API key:', apiKey.substring(0, 10) + '...');
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

// Profession to icons mapping
const PROFESSION_ICONS: Record<string, string[]> = {
  // Music
  'певец': ['musical notes', 'microphone', 'vinyl record'],
  'певица': ['musical notes', 'microphone', 'heart'],
  'музыкант': ['guitar', 'musical notes', 'piano keys'],
  'рэпер': ['microphone', 'headphones', 'chain necklace'],
  'композитор': ['treble clef', 'piano', 'sheet music'],
  'диджей': ['turntable', 'headphones', 'sound waves'],
  
  // Acting
  'актер': ['film reel', 'theater masks', 'Oscar statue'],
  'актриса': ['film reel', 'theater masks', 'star'],
  'режиссер': ['film clapper', 'director chair', 'camera'],
  'комик': ['laughing face', 'microphone', 'spotlight'],
  
  // Sports
  'боксер': ['boxing gloves', 'championship belt', 'punching bag'],
  'футболист': ['soccer ball', 'goal net', 'trophy'],
  'баскетболист': ['basketball', 'hoop', 'sneakers'],
  'теннисист': ['tennis racket', 'tennis ball', 'net'],
  'гонщик': ['racing car', 'checkered flag', 'helmet'],
  'боец': ['fist', 'octagon', 'championship belt'],
  
  // Science & Tech
  'ученый': ['atom', 'test tube', 'microscope'],
  'физик': ['E=mc²', 'atom', 'equations'],
  'изобретатель': ['light bulb', 'gears', 'blueprint'],
  'программист': ['code brackets', 'laptop', 'binary code'],
  'предприниматель': ['rocket', 'chart', 'light bulb'],
  
  // Literature & Art
  'писатель': ['book', 'quill pen', 'inkwell'],
  'художник': ['paint brush', 'palette', 'canvas'],
  'поэт': ['feather', 'scroll', 'rose'],
  
  // Politics & Leadership
  'политик': ['podium', 'flag', 'dove'],
  'президент': ['seal', 'flag', 'podium'],
  'революционер': ['raised fist', 'flag', 'broken chain'],
  
  // Fashion & Lifestyle
  'модель': ['runway', 'camera flash', 'high heels'],
  'дизайнер': ['scissors', 'mannequin', 'fabric'],
  
  // Famous people specific icons
  'павел дуров': ['paper airplane (Telegram icon)', 'phone', 'lock'],
  'илон маск': ['rocket', 'Tesla logo', 'Mars planet'],
  'стив джобс': ['bitten apple', 'iPhone', 'infinity'],
  'эйнштейн': ['E=mc²', 'brain', 'atom'],
  'альберт эйнштейн': ['E=mc²', 'brain', 'atom'],
  'конор макгрегор': ['boxing gloves', 'UFC octagon', 'Irish flag'],
  'майк тайсон': ['boxing gloves', 'pigeon', 'championship belt'],
  'мохаммед али': ['boxing gloves', 'bee', 'butterfly'],
  'уилл смит': ['Oscar statue', 'microphone', 'crown'],
  'мэрилин монро': ['red lips', 'diamond', 'wind-blown dress'],
  'чарли чаплин': ['bowler hat', 'cane', 'silent film reel'],
  'никола тесла': ['lightning bolt', 'coil', 'AC current symbol'],
  'леонардо да винчи': ['Vitruvian man', 'paint brush', 'gears'],
  'мария кюри': ['radiation symbol', 'test tube', 'Nobel medal'],
  'стивен хокинг': ['black hole', 'wheelchair', 'stars'],
  'фрида кало': ['flower crown', 'unibrow', 'heart'],
  'пабло пикассо': ['cubist eye', 'paint brush', 'bull'],
  'сальвадор дали': ['melting clock', 'mustache', 'elephant'],
  'курт кобейн': ['guitar', 'grunge star', 'broken heart'],
  'эми уайнхаус': ['beehive hair', 'microphone', 'broken heart'],
  'адель': ['microphone', 'vinyl record', 'tears'],
};

// Color palette for random selection
const COLOR_COMBINATIONS = [
  'vibrant orange and yellow',
  'electric blue and purple',
  'fiery red and orange',
  'neon green and cyan',
  'golden yellow and amber',
  'deep purple and magenta',
  'sunset pink and coral',
  'ocean blue and turquoise',
  'emerald green and gold',
  'crimson red and black',
  'royal purple and silver',
  'tropical teal and lime',
];

export interface CoverGenerationOptions {
  heroName: string;
  title: string;
  colorScheme?: string;
  icons?: string[];
  sharpFact?: string;
  articleContent?: any;
}

/**
 * Extract sharp fact from article content
 */
function extractSharpFact(content: any, heroName: string): string {
  const sharpFactPatterns = [
    /потерял|потеряла|лишился|лишилась/i,
    /жил с |жила с |спал на |спала на /i,
    /банкрот|долг|нищ|бедн/i,
    /умер|умерла|погиб|скончал/i,
    /отверг|отказ|провал|провалил/i,
    /наркотик|алкогол|зависим/i,
    /тюрьм|арест|суд|обвин/i,
    /болезн|болен|страдал|страдала/i,
    /бросил|бросила|ушел|ушла/i,
    /выгнали|уволили|исключили/i,
  ];

  let bestFact = '';
  let bestScore = 0;

  if (content.sections) {
    for (const section of content.sections) {
      const text = section.paragraph1 || section.content || '';
      for (const pattern of sharpFactPatterns) {
        if (pattern.test(text)) {
          const match = text.match(pattern);
          if (match && match.index !== undefined) {
            const start = Math.max(0, match.index - 20);
            const end = Math.min(text.length, match.index + 50);
            const snippet = text.slice(start, end).trim();
            const score = sharpFactPatterns.filter(p => p.test(snippet)).length;
            if (score > bestScore) {
              bestScore = score;
              bestFact = snippet;
            }
          }
        }
      }
    }
  }

  if (!bestFact && content.sections?.[0]) {
    const firstSection = content.sections[0];
    const heading = firstSection.heading || firstSection.title || '';
    bestFact = heading.length > 5 ? heading : 'путь к славе';
  }

  const words = bestFact.split(/\s+/).slice(0, 5);
  return words.join(' ').replace(/[.,!?;:]$/, '');
}

/**
 * Get icons based on hero name and profession
 */
function getIconsForHero(heroName: string, content?: any): string[] {
  const nameLower = heroName.toLowerCase();
  
  for (const [key, icons] of Object.entries(PROFESSION_ICONS)) {
    if (nameLower.includes(key)) {
      return icons;
    }
  }

  if (content?.sections) {
    const allText = content.sections.map((s: any) => 
      (s.paragraph1 || '') + (s.paragraph2 || '') + (s.content || '')
    ).join(' ').toLowerCase();
    
    for (const [profession, icons] of Object.entries(PROFESSION_ICONS)) {
      if (allText.includes(profession)) {
        return icons;
      }
    }
  }

  return ['star', 'spotlight', 'crown'];
}

/**
 * Get random color combination
 */
function getRandomColors(): string {
  return COLOR_COMBINATIONS[Math.floor(Math.random() * COLOR_COMBINATIONS.length)];
}

/**
 * Build the cover generation prompt. Exported so alternative providers
 * (OpenAI gpt-image, etc.) can reuse the exact same specification.
 *
 * variant:
 *  - 'photoreal' (default, Gemini) — realistic photo-collage style
 *  - 'illustration' (OpenAI) — explicitly stylized/painted, NOT photorealistic.
 *    OpenAI's safety system blocks photorealistic depictions of real public
 *    figures far more often than clearly artistic ones; asking for an
 *    illustration keeps the same composition while passing moderation more
 *    reliably.
 */
export function buildCoverPrompt(options: CoverGenerationOptions, variant: 'photoreal' | 'illustration' = 'photoreal'): {
  prompt: string;
  heroName: string;
  title: string;
  colorScheme: string;
  icons: string[];
  sharpFact: string;
} {
  const {
    heroName,
    title,
    colorScheme = getRandomColors(),
    icons = getIconsForHero(heroName, options.articleContent),
  } = options;

  const sharpFact = options.articleContent?.coverHook ||
                    options.sharpFact ||
                    extractSharpFact(options.articleContent || {}, heroName);

  const iconsText = icons.join(', ');

  const styleLine = variant === 'illustration'
    ? 'Stylized editorial illustration collage — hand-painted artwork, clearly artistic and NOT photorealistic — with dramatic, inspiring visual impact'
    : 'Realistic photo collage editorial cover art with dramatic, inspiring visual impact';
  const portraitLine = variant === 'illustration'
    ? `Dignified stylized painted portrait of ${heroName} in their prime — a respectful artistic illustration, clearly an artwork rather than a photograph — presented as a torn-edge paper collage cutout layered on top of the chalkboard with a subtle drop shadow, confident and inspiring expression, direct eye contact with viewer`
    : `Dignified editorial-style illustrated portrait of ${heroName} in their prime, presented as a torn-edge paper collage cutout layered on top of the chalkboard with a subtle drop shadow, confident and inspiring expression, direct eye contact with viewer`;
  const finalStyleLine = variant === 'illustration'
    ? 'Cohesive illustrated artwork on aged chalkboard, magazine-cover quality'
    : 'Blend of photography and chalk illustration on aged chalkboard, magazine-cover quality';

  const prompt = `Editorial cover illustration for a motivational biography feature (in the style of Forbes/Time "comeback story" profiles) celebrating ${heroName}'s resilience, perseverance and rise to success. Tone: respectful, uplifting, inspirational — this is a tribute to how they overcame adversity on the way to achievement, not a negative, mocking, or sensational depiction. Design specifications:
- Style: ${styleLine}
- Central element: ${portraitLine}
- Background: Dark, textured chalkboard with chalk scratches and artistic marks
- Visual accent: Vibrant ${colorScheme} cloud/aura effect behind the figure using chalk/pastel style, evoking triumph and energy
- Icons: Include ${iconsText} as chalk-drawn elements celebrating ${heroName}'s achievements
- Text elements:
  * Title at top in chalk font: "${title}"
  * Arrow pointing to figure with a short annotation naming the obstacle they overcame on their path to success: "${sharpFact}"
- Final style: ${finalStyleLine}
- Quality: Sharp, legible text and diagrams, professional finish
- Aspect ratio: 16:9, resolution: 4K`;

  return { prompt, heroName, title, colorScheme, icons, sharpFact };
}

/**
 * Generate cover image via the Gemini generateContent REST API (Nano Banana family).
 * Defaults to gemini-3.1-flash-image-preview (Nano Banana 2); pass modelName to use
 * gemini-3-pro-image-preview (Nano Banana Pro) for higher-quality composited covers.
 */
export async function generateCoverImage(
  options: CoverGenerationOptions,
  modelName: string = 'gemini-3.1-flash-image-preview'
): Promise<{
  success: boolean;
  imageBase64?: string;
  imagePath?: string;
  error?: string;
}> {
  const { prompt, sharpFact } = buildCoverPrompt(options);

  console.log(`🎨 Cover sharp fact: "${sharpFact}"`);

  // generateContent (same endpoint shape as text models) handles celebrity-related
  // prompts correctly. Imagen models block photorealistic portraits of real named people.
  console.log(`🎨 Generating cover with ${modelName}...`);
  console.log('📝 Prompt (first 300 chars):', prompt.substring(0, 300));

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Attempt ${attempt}/${maxRetries} to generate cover...`);

        const controller = new AbortController();
        // Pro is noticeably slower than Flash, give it more room before aborting.
        const timeoutMs = modelName.includes('pro') ? 180000 : 120000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        // generateContent with responseModalities IMAGE
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
          {
            method: 'POST',
            headers: {
              'x-goog-api-key': apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
            }),
            signal: controller.signal,
          }
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData = await response.json() as any;
          console.error('❌ Gemini image API error:', JSON.stringify(errorData).substring(0, 500));
          const errorMessage = JSON.stringify(errorData?.error ?? errorData);
          const httpCode = errorData?.error?.code ?? response.status;
          const isRetryable = httpCode === 429 || httpCode === 503 ||
            errorMessage.includes('overloaded') || errorMessage.includes('RESOURCE_EXHAUSTED') ||
            errorMessage.includes('UNAVAILABLE');
          if (isRetryable) {
            console.log(`⏳ API overloaded/rate-limited (${httpCode}), waiting before retry...`);
            await new Promise(resolve => setTimeout(resolve, 10000 * attempt));
            lastError = new Error(errorMessage);
            continue;
          }
          throw new Error(errorMessage);
        }

        const data = await response.json() as any;

        // Extract image from generateContent response:
        // { candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] }
        let imageBase64: string | undefined;
        let imageMime = 'image/png';
        const parts = data?.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part?.inlineData?.data) {
            imageBase64 = part.inlineData.data;
            imageMime = part.inlineData.mimeType ?? 'image/png';
            break;
          }
        }

        if (!imageBase64) {
          // Log the full response to diagnose content-filter or format issues
          console.error('❌ No image in response. Full response:',
            JSON.stringify(data, null, 2).substring(0, 1500));
          // Check for content filter
          const finishReason = data?.candidates?.[0]?.finishReason;
          if (finishReason && finishReason !== 'STOP') {
            throw new Error(`Image generation blocked: finishReason=${finishReason}`);
          }
          throw new Error('No image data in generateContent response');
        }

        const storageBase = process.env.STORAGE_PATH || process.cwd();
        const coversDir = path.join(storageBase, 'covers');
        await fs.mkdir(coversDir, { recursive: true });

        const ext = imageMime.includes('png') ? 'png' : 'jpg';
        const fileName = `cover_${Date.now()}.${ext}`;
        const filePath = path.join(coversDir, fileName);

        await fs.writeFile(filePath, Buffer.from(imageBase64, 'base64'));
        console.log('✅ Cover image generated and saved:', filePath);

        return { success: true, imageBase64, imagePath: filePath };

      } catch (retryError: any) {
        lastError = retryError;
        console.error(`❌ Attempt ${attempt} failed:`, retryError.message);
        const isTransient = retryError.name === 'AbortError' ||
          retryError.message?.includes('timeout') ||
          retryError.message?.includes('fetch failed') ||
          retryError.message?.includes('503') ||
          retryError.message?.includes('429');
        if (isTransient && attempt < maxRetries) {
          console.log(`⏳ Transient error, waiting ${5000 * attempt}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
          continue;
        }
        break;
      }
    }

    console.error('❌ All retries exhausted for cover generation');
    return {
      success: false,
      error: lastError?.message || 'Failed to generate cover image after retries',
    };
  } catch (error: any) {
    console.error('❌ Cover generation error:', error);
    return {
      success: false,
      error: error.message || 'Failed to generate cover image',
    };
  }
}

/**
 * Generate cover image using gemini-3-pro-image-preview (Nano Banana Pro) — same prompt
 * and pipeline as generateCoverImage, but the premium-quality model for complex composites.
 */
export async function generateCoverImageGeminiPro(options: CoverGenerationOptions) {
  return generateCoverImage(options, 'gemini-3-pro-image-preview');
}

/**
 * Get cover generation options preview
 */
export function getCoverPreviewOptions(heroName: string, articleContent?: any): {
  suggestedColors: string[];
  suggestedIcons: string[];
  suggestedFact: string;
} {
  // Prefer coverHook from Claude, fallback to extraction
  const suggestedFact = articleContent?.coverHook || 
                        extractSharpFact(articleContent || {}, heroName);
  
  return {
    suggestedColors: COLOR_COMBINATIONS.slice(0, 6),
    suggestedIcons: getIconsForHero(heroName, articleContent),
    suggestedFact,
  };
}

/**
 * Get all available color combinations
 */
export function getAllColorCombinations(): string[] {
  return COLOR_COMBINATIONS;
}
