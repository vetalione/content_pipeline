/**
 * AI-drawn illustrations for article facts/blocks in the brand's signature
 * cover style: a stylized vintage scene rendered as a torn-edge collage
 * sticker on a dark chalkboard with chalk accents.
 *
 * Unlike the cover (which has title/arrow/fact text), an illustration depicts
 * a concrete SCENE from the hero's life — taken from the fact's
 * visualSuggestion produced at research time — and contains NO text at all
 * (image models garble lettering, and the caption already lives in the article).
 *
 * Models: 'gemini' (Nano Banana 2) or 'openai' (gpt-image-2). When OpenAI
 * blocks a real public figure ("public-figure" moderation category) we make
 * ONE fallback to Gemini and never re-send the blocked request.
 */

import { promises as fs } from 'fs';
import path from 'path';

export type IllustrationModel = 'openai' | 'gemini';

export interface IllustrationOptions {
  heroName: string;
  /** Scene description — ideally the fact's visualSuggestion from research */
  sceneDescription: string;
  year?: number;
}

export interface IllustrationResult {
  success: boolean;
  /** Local path like /images/gen_123.png (same serving path as found images) */
  imagePath?: string;
  /** Which model actually drew the image (может отличаться при фолбэке) */
  usedModel?: IllustrationModel;
  error?: string;
}

export function buildIllustrationPrompt(options: IllustrationOptions): string {
  const { heroName, sceneDescription, year } = options;
  return `Vintage editorial illustration for a motivational biography article about ${heroName} (a respectful, uplifting "comeback story" feature).

SCENE TO DEPICT — a real moment from their life${year ? `, around ${year}` : ''}:
${sceneDescription}

VISUAL STYLE (house style of the publication — follow strictly):
- The scene is rendered as a stylized hand-painted vintage picture with muted, aged tones — clearly an artistic illustration, NOT a photograph
- The picture is presented as a torn-edge paper collage sticker with a thin white border and a soft drop shadow
- The sticker is layered on a dark textured chalkboard background with subtle chalk scratches
- Around the sticker: a few small chalk-drawn accent marks (rays, stars, small arrows) in one or two vibrant chalk colors, evoking energy and warmth
- Era-appropriate clothing, objects and environment for the depicted moment
- Respectful, warm, empathetic tone — no mockery, no caricature, no distortion of the person
- NO text, NO captions, NO lettering, NO numbers anywhere in the image
- Aspect ratio: 16:9`;
}

async function saveIllustration(base64: string, mime: string): Promise<string> {
  const storageBase = process.env.STORAGE_PATH || process.cwd();
  const imagesDir = path.join(storageBase, 'images');
  await fs.mkdir(imagesDir, { recursive: true });
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const fileName = `gen_${Date.now()}.${ext}`;
  await fs.writeFile(path.join(imagesDir, fileName), Buffer.from(base64, 'base64'));
  return `/images/${fileName}`;
}

async function drawWithGemini(prompt: string): Promise<IllustrationResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { success: false, error: 'GEMINI_API_KEY is not set' };

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
          }),
          signal: controller.signal,
        }
      );
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as any;
        const errorMessage = JSON.stringify(errorData?.error ?? errorData);
        const httpCode = errorData?.error?.code ?? response.status;
        const isRetryable = httpCode === 429 || httpCode === 503 ||
          errorMessage.includes('overloaded') || errorMessage.includes('RESOURCE_EXHAUSTED') ||
          errorMessage.includes('UNAVAILABLE');
        if (isRetryable && attempt < maxRetries) {
          console.log(`⏳ [Illustration/Gemini] transient ${httpCode}, retrying...`);
          await new Promise(r => setTimeout(r, 8000 * attempt));
          lastError = new Error(errorMessage);
          continue;
        }
        throw new Error(errorMessage);
      }

      const data = (await response.json()) as any;
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part?.inlineData?.data) {
          const imagePath = await saveIllustration(part.inlineData.data, part.inlineData.mimeType ?? 'image/png');
          console.log(`✅ [Illustration/Gemini] drawn and saved: ${imagePath}`);
          return { success: true, imagePath, usedModel: 'gemini' };
        }
      }

      const finishReason = data?.candidates?.[0]?.finishReason;
      throw new Error(finishReason && finishReason !== 'STOP'
        ? `Image generation blocked: finishReason=${finishReason}`
        : 'No image data in generateContent response');
    } catch (err: any) {
      lastError = err;
      const isTransient = err.name === 'AbortError' ||
        err.message?.includes('timeout') || err.message?.includes('fetch failed');
      if (isTransient && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 5000 * attempt));
        continue;
      }
      break;
    }
  }
  return { success: false, error: lastError?.message || 'Gemini illustration failed after retries' };
}

async function drawWithOpenAI(prompt: string): Promise<IllustrationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { success: false, error: 'OPENAI_API_KEY is not set' };

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000);

      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt,
          // 16:9 like section images; 'medium' quality — an illustration per
          // fact would double article cost at 'high' for marginal gain
          size: '2048x1152',
          quality: 'medium',
          n: 1,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as any;
        const errorMessage = JSON.stringify(errorData?.error ?? errorData);
        const httpCode = response.status;
        // moderation_blocked (400) is NEVER retried — caller falls back to Gemini
        const isRetryable =
          httpCode === 429 || httpCode === 500 || httpCode === 502 || httpCode === 503 || httpCode === 504;
        if (isRetryable && attempt < maxRetries) {
          console.log(`⏳ [Illustration/OpenAI] transient ${httpCode}, retrying...`);
          await new Promise(r => setTimeout(r, 8000 * attempt));
          lastError = new Error(errorMessage);
          continue;
        }
        throw new Error(errorMessage);
      }

      const data = (await response.json()) as any;
      const imageBase64: string | undefined = data?.data?.[0]?.b64_json;
      if (!imageBase64) throw new Error('No b64_json in OpenAI images response');

      const imagePath = await saveIllustration(imageBase64, 'image/png');
      console.log(`✅ [Illustration/OpenAI] drawn and saved: ${imagePath}`);
      return { success: true, imagePath, usedModel: 'openai' };
    } catch (err: any) {
      lastError = err;
      const isTransient = err.name === 'AbortError' ||
        err.message?.includes('timeout') || err.message?.includes('fetch failed');
      if (isTransient && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 5000 * attempt));
        continue;
      }
      break;
    }
  }
  return { success: false, error: lastError?.message || 'OpenAI illustration failed after retries' };
}

export async function generateIllustration(
  options: IllustrationOptions,
  model: IllustrationModel = 'gemini'
): Promise<IllustrationResult> {
  const prompt = buildIllustrationPrompt(options);
  console.log(`🖌 Drawing illustration (${model}) for ${options.heroName}: "${options.sceneDescription.substring(0, 100)}..."`);

  let result = model === 'openai' ? await drawWithOpenAI(prompt) : await drawWithGemini(prompt);

  // Same policy as covers: one clean fallback to Gemini when OpenAI's safety
  // system blocks the real public figure; never re-send the blocked request.
  if (!result.success && model === 'openai' && String(result.error || '').includes('moderation_blocked')) {
    console.warn('⚠️ OpenAI moderation blocked the illustration (public figure). Falling back to Gemini.');
    result = await drawWithGemini(prompt);
  }

  return result;
}
