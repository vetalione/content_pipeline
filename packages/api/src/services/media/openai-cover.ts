import { promises as fs } from 'fs';
import path from 'path';
import { buildCoverPrompt, CoverGenerationOptions } from './gemini-cover';

/**
 * Generate cover image using OpenAI gpt-image-1 (ChatGPT Images).
 * Reuses the exact same prompt specification as the Gemini Nano Banana path
 * so results are comparable across providers.
 */
export async function generateCoverImageOpenAI(options: CoverGenerationOptions): Promise<{
  success: boolean;
  imageBase64?: string;
  imagePath?: string;
  error?: string;
}> {
  const { prompt, sharpFact } = buildCoverPrompt(options);

  console.log(`🎨 [OpenAI] Cover sharp fact: "${sharpFact}"`);
  console.log('🎨 Generating cover with gpt-image-2...');
  console.log('📝 Prompt (first 300 chars):', prompt.substring(0, 300));

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'OPENAI_API_KEY environment variable is not set' };
  }

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 [OpenAI] Attempt ${attempt}/${maxRetries} to generate cover...`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 min timeout

      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt,
          // True 16:9 landscape at 2K — matches the "16:9, 4K" spec in the prompt
          // (3840x2160 is also supported but doubles cost for marginal gain).
          size: '2048x1152',
          quality: 'high',
          n: 1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as any;
        const errorMessage = JSON.stringify(errorData?.error ?? errorData);
        console.error('❌ OpenAI image API error:', errorMessage.substring(0, 500));
        const httpCode = response.status;
        const isRetryable =
          httpCode === 429 || httpCode === 500 || httpCode === 502 || httpCode === 503 || httpCode === 504;
        if (isRetryable && attempt < maxRetries) {
          console.log(`⏳ OpenAI transient error (${httpCode}), retrying...`);
          await new Promise((r) => setTimeout(r, 8000 * attempt));
          lastError = new Error(errorMessage);
          continue;
        }
        throw new Error(errorMessage);
      }

      const data = (await response.json()) as any;
      const imageBase64: string | undefined = data?.data?.[0]?.b64_json;

      if (!imageBase64) {
        console.error(
          '❌ No image in OpenAI response. Raw:',
          JSON.stringify(data).substring(0, 1500),
        );
        throw new Error('No b64_json in OpenAI images response');
      }

      const storageBase = process.env.STORAGE_PATH || process.cwd();
      const coversDir = path.join(storageBase, 'covers');
      await fs.mkdir(coversDir, { recursive: true });

      const fileName = `cover_${Date.now()}.png`;
      const filePath = path.join(coversDir, fileName);

      await fs.writeFile(filePath, Buffer.from(imageBase64, 'base64'));
      console.log('✅ [OpenAI] Cover image generated and saved:', filePath);

      return { success: true, imageBase64, imagePath: filePath };
    } catch (retryError: any) {
      lastError = retryError;
      console.error(`❌ [OpenAI] Attempt ${attempt} failed:`, retryError.message);
      const isTransient =
        retryError.name === 'AbortError' ||
        retryError.message?.includes('timeout') ||
        retryError.message?.includes('fetch failed');
      if (isTransient && attempt < maxRetries) {
        console.log(`⏳ [OpenAI] Transient error, waiting ${5000 * attempt}ms before retry...`);
        await new Promise((r) => setTimeout(r, 5000 * attempt));
        continue;
      }
      break;
    }
  }

  return {
    success: false,
    error: lastError?.message || 'Failed to generate cover image via OpenAI after retries',
  };
}
