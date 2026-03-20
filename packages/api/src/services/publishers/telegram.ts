/**
 * Telegram Publisher — Telegraph article + channel post with cover
 *
 * Flow:
 * 1. Create full article on Telegra.ph (title, cover, sections, quotes, images)
 * 2. Post to Telegram channel: cover image + title + teaser + link to Telegraph
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   TELEGRAM_CHANNEL_ID  — @username or -100... numeric ID
 *   TELEGRAPH_TOKEN      — auto-created on first run if missing
 */

import fs from 'fs';
import path from 'path';
import { ArticleContent, CoverImage } from '@content-pipeline/shared';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ArticleWithCover = {
  id: string;
  celebrityName: string;
  content: ArticleContent | any;
  coverImages?: CoverImage[];
  coverImage?: CoverImage;
  [key: string]: any;
};

/** Telegraph Node — the content format Telegra.ph API uses */
export interface TelegraphNode {
  tag?: string;
  attrs?: Record<string, string>;
  children?: (TelegraphNode | string)[];
}

// ── Config ─────────────────────────────────────────────────────────────────────

const TELEGRAPH_API = 'https://api.telegra.ph';
const TELEGRAM_API = 'https://api.telegram.org';

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  return token;
}

function getChannelId(): string {
  const id = process.env.TELEGRAM_CHANNEL_ID;
  if (!id) throw new Error('TELEGRAM_CHANNEL_ID not set');
  return id;
}

// ── Telegraph Token Management ─────────────────────────────────────────────────

const TELEGRAPH_TOKEN_FILE = path.join(
  process.env.STORAGE_PATH || process.cwd(),
  'telegraph-token.json'
);

export async function getTelegraphToken(): Promise<string> {
  // 1. Check env var
  if (process.env.TELEGRAPH_TOKEN) {
    return process.env.TELEGRAPH_TOKEN;
  }

  // 2. Check saved file
  if (fs.existsSync(TELEGRAPH_TOKEN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TELEGRAPH_TOKEN_FILE, 'utf-8'));
      if (data.access_token) return data.access_token;
    } catch { /* ignore */ }
  }

  // 3. Create new account
  console.log('📝 Creating Telegraph account...');
  const res = await fetch(`${TELEGRAPH_API}/createAccount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      short_name: 'ContentPipeline',
      author_name: 'Content Pipeline',
    }),
  });

  const data = await res.json() as any;
  if (!data.ok || !data.result?.access_token) {
    throw new Error('Failed to create Telegraph account: ' + JSON.stringify(data));
  }

  const token = data.result.access_token;
  // Save for reuse
  const dir = path.dirname(TELEGRAPH_TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TELEGRAPH_TOKEN_FILE, JSON.stringify({ access_token: token }));
  console.log('   ✅ Telegraph account created');

  return token;
}

// ── Image Helpers ──────────────────────────────────────────────────────────────

/** Get the public base URL of our API server (Railway domain or custom) */
function getPublicBaseUrl(): string | null {
  if (process.env.API_BASE_URL) return process.env.API_BASE_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

/** Convert a local path to a public URL (fallback when imgbb is not configured) */
function getPublicImageUrl(localPath: string): string | null {
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) return null;
  if (localPath.startsWith('/images/') || localPath.startsWith('/covers/')) {
    return `${baseUrl}${localPath}`;
  }
  const storageBase = process.env.STORAGE_PATH || process.cwd();
  if (localPath.startsWith(storageBase)) {
    const relative = localPath.substring(storageBase.length);
    const normalized = relative.startsWith('/') ? relative : `/${relative}`;
    if (normalized.startsWith('/images/') || normalized.startsWith('/covers/')) {
      return `${baseUrl}${normalized}`;
    }
  }
  return null;
}

/** Resolve local path (/images/..., /covers/...) or full filesystem path to absolute path */
export function resolveImagePath(imagePath: string): string {
  const storageBase = process.env.STORAGE_PATH || process.cwd();
  if (imagePath.startsWith('/images/') || imagePath.startsWith('/covers/')) {
    return path.join(storageBase, imagePath);
  }
  return imagePath;
}

// ── imgbb — permanent free image hosting ───────────────────────────────────────

/**
 * Upload an image to imgbb.com (free, permanent hosting).
 * Env: IMGBB_API_KEY — get one free at https://api.imgbb.com/
 * Returns the public display URL or null on failure.
 */
export async function uploadToImgbb(imagePath: string): Promise<string | null> {
  const apiKey = process.env.IMGBB_API_KEY;
  if (!apiKey) return null;

  const resolved = resolveImagePath(imagePath);
  if (!fs.existsSync(resolved)) {
    console.error(`   ⚠️ imgbb: file not found: ${resolved}`);
    return null;
  }

  try {
    const imageBase64 = fs.readFileSync(resolved).toString('base64');
    const name = path.basename(resolved, path.extname(resolved));

    const params = new URLSearchParams({
      key: apiKey,
      image: imageBase64,
      name,
    });

    const res = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: params,
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json() as any;
    if (data.success && data.data?.display_url) {
      console.log(`   📤 imgbb: ${data.data.display_url.substring(0, 70)}`);
      return data.data.display_url;
    }

    console.error('   ⚠️ imgbb upload failed:', JSON.stringify(data).substring(0, 200));
    return null;
  } catch (err: any) {
    console.error('   ⚠️ imgbb error:', err.message);
    return null;
  }
}

/** Get image URL for Telegraph content.
 *  Priority: remote URL → imgbb (permanent) → Railway public URL (fallback) */
async function getImageForTelegraph(imagePath: string): Promise<string | null> {
  if (!imagePath) return null;

  // Already a remote URL — use directly
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    return imagePath;
  }

  // 1. imgbb — permanent free hosting (preferred)
  const imgbbUrl = await uploadToImgbb(imagePath);
  if (imgbbUrl) return imgbbUrl;

  // 2. Railway public URL — works while Railway hosts the file
  const publicUrl = getPublicImageUrl(imagePath);
  if (publicUrl) {
    console.log(`   🔗 Fallback to public URL: ${publicUrl.substring(0, 80)}`);
    return publicUrl;
  }

  console.error(`   ⚠️ No image hosting available for: ${imagePath.substring(0, 80)}`);
  return null;
}

// ── Telegraph Content Builder ──────────────────────────────────────────────────

/** Build Telegraph content nodes from ArticleContent */
export async function buildTelegraphContent(
  content: ArticleContent,
  coverImage: CoverImage | undefined
): Promise<TelegraphNode[]> {
  const nodes: TelegraphNode[] = [];

  // Cover image
  if (coverImage) {
    const coverSrc = coverImage.processedImageUrl || coverImage.localPath || coverImage.originalImageUrl;
    const coverUrl = await getImageForTelegraph(coverSrc);
    if (coverUrl) {
      nodes.push({ tag: 'img', attrs: { src: coverUrl } });
    }
  }

  // Teaser (italic)
  if (content.teaser) {
    nodes.push({ tag: 'p', children: [{ tag: 'em', children: [content.teaser] }] });
  }

  // Horizontal rule after teaser
  nodes.push({ tag: 'hr' });

  // Sections
  for (const section of content.sections) {
    // Section heading
    nodes.push({ tag: 'h4', children: [section.heading] });

    // Section image
    if (section.imageUrl) {
      const imgUrl = await getImageForTelegraph(section.imageUrl);
      if (imgUrl) {
        nodes.push({ tag: 'img', attrs: { src: imgUrl } });
      }
    }

    // Paragraphs
    if (section.paragraph1) {
      nodes.push({ tag: 'p', children: [section.paragraph1] });
    }
    if (section.paragraph2) {
      nodes.push({ tag: 'p', children: [section.paragraph2] });
    }

    // Blockquote
    if (section.blockquote) {
      nodes.push({ tag: 'blockquote', children: [section.blockquote] });
    }
  }

  // Conclusion
  if (content.conclusion) {
    nodes.push({ tag: 'hr' });
    nodes.push({ tag: 'h4', children: [content.conclusion.heading] });
    nodes.push({ tag: 'p', children: [content.conclusion.text] });
  }

  // Hero quote
  if (content.heroQuote) {
    nodes.push({
      tag: 'blockquote',
      children: [`«${content.heroQuote.text}» — ${content.heroQuote.author}`],
    });
  }

  // Bonus fact
  if (content.bonusFact) {
    nodes.push({ tag: 'h4', children: ['🎁 Бонусный факт:'] });
    nodes.push({ tag: 'p', children: [content.bonusFact] });
  }

  // CTA
  if (content.cta) {
    nodes.push({ tag: 'hr' });
    nodes.push({ tag: 'p', children: [{ tag: 'strong', children: [content.cta] }] });
  }

  // Brand ending
  if (content.brandEnding) {
    nodes.push({ tag: 'p', children: [{ tag: 'em', children: [content.brandEnding] }] });
  }

  return nodes;
}

// ── Telegraph Publishing ───────────────────────────────────────────────────────

/** Create a Telegraph article, returns the URL */
export async function createTelegraphPage(
  token: string,
  title: string,
  content: TelegraphNode[],
  authorName?: string
): Promise<string> {
  const res = await fetch(`${TELEGRAPH_API}/createPage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: token,
      title,
      content,
      author_name: authorName || 'Content Pipeline',
      return_content: false,
    }),
  });

  const data = await res.json() as any;
  if (!data.ok || !data.result?.url) {
    throw new Error('Telegraph createPage failed: ' + JSON.stringify(data).substring(0, 300));
  }

  return data.result.url;
}

// ── Telegram Bot Posting ───────────────────────────────────────────────────────

/** Send a photo with caption to the Telegram channel */
async function sendChannelPost(
  title: string,
  teaser: string,
  telegraphUrl: string,
  coverImage: CoverImage | undefined
): Promise<string> {
  const botToken = getBotToken();
  const channelId = getChannelId();

  // Build caption (HTML format, max 1024 chars for photo caption)
  const caption = [
    `<b>${escapeHtml(title)}</b>`,
    '',
    escapeHtml(teaser.length > 600 ? teaser.substring(0, 597) + '...' : teaser),
    '',
    `👉 <a href="${telegraphUrl}">Читать полностью</a>`,
  ].join('\n');

  // Try to send with cover photo
  if (coverImage) {
    const coverSrc = coverImage.processedImageUrl || coverImage.localPath || coverImage.originalImageUrl;
    const messageUrl = await sendPhotoMessage(botToken, channelId, coverSrc, caption);
    if (messageUrl) return messageUrl;
  }

  // Fallback: text-only message (4096 char limit)
  return sendTextMessage(botToken, channelId, caption);
}

/** Send photo message, returns message URL or null on failure */
async function sendPhotoMessage(
  botToken: string,
  channelId: string,
  photoSource: string,
  caption: string
): Promise<string | null> {
  try {
    // Resolve local paths to remote URLs
    if (!photoSource.startsWith('http://') && !photoSource.startsWith('https://')) {
      // Try imgbb (permanent)
      const imgbbUrl = await uploadToImgbb(photoSource);
      if (imgbbUrl) {
        photoSource = imgbbUrl;
      } else {
        // Try Railway public URL
        const publicUrl = getPublicImageUrl(photoSource);
        if (publicUrl) {
          console.log(`   🔗 Cover: fallback to public URL: ${publicUrl.substring(0, 80)}`);
          photoSource = publicUrl;
        } else {
          // Last resort: upload file directly via multipart
          return await sendPhotoMultipart(botToken, channelId, photoSource, caption);
        }
      }
    }

    // Remote URL — pass as JSON (simple and reliable)
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        photo: photoSource,
        caption,
        parse_mode: 'HTML',
      }),
    });

    const data = await res.json() as any;
    if (data.ok && data.result) {
      return buildMessageUrl(channelId, data.result.message_id);
    }
    console.error('   ⚠️ sendPhoto (URL) failed:', JSON.stringify(data).substring(0, 200));
    return null;
  } catch (err: any) {
    console.error('   ⚠️ sendPhoto error:', err.message);
    return null;
  }
}

/** Upload a local file directly to Telegram via multipart (fallback) */
async function sendPhotoMultipart(
  botToken: string,
  channelId: string,
  photoSource: string,
  caption: string
): Promise<string | null> {
  const resolved = resolveImagePath(photoSource);
  if (!fs.existsSync(resolved)) {
    console.error(`   ⚠️ Cover file not found: ${resolved}`);
    return null;
  }

  const imageBuffer = fs.readFileSync(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

  const https = await import('https');
  const boundary = '----TelegramUpload' + Math.random().toString(36).substring(2);
  const parts: Buffer[] = [];

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="photo"; filename="cover${ext}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  ));
  parts.push(imageBuffer);
  parts.push(Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="chat_id"\r\n\r\n${channelId}`
  ));
  parts.push(Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}`
  ));
  parts.push(Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="parse_mode"\r\n\r\nHTML`
  ));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const data = await new Promise<any>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/sendPhoto`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
          catch { reject(new Error('Invalid JSON from Telegram')); }
        });
      }
    );
    req.on('error', (err: Error) => reject(err));
    req.write(body);
    req.end();
  });

  if (data.ok && data.result) {
    return buildMessageUrl(channelId, data.result.message_id);
  }
  console.error('   ⚠️ sendPhoto multipart failed:', JSON.stringify(data).substring(0, 200));
  return null;
}

/** Send text-only message */
async function sendTextMessage(
  botToken: string,
  channelId: string,
  text: string
): Promise<string> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: channelId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });

  const data = await res.json() as any;
  if (!data.ok) {
    throw new Error('sendMessage failed: ' + JSON.stringify(data).substring(0, 300));
  }

  return buildMessageUrl(channelId, data.result.message_id);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildMessageUrl(channelId: string, messageId: number): string {
  // @username format
  if (channelId.startsWith('@')) {
    return `https://t.me/${channelId.slice(1)}/${messageId}`;
  }
  // Numeric ID: -100XXXXXXXXXX → t.me/c/XXXXXXXXXX/messageId
  const numericId = channelId.replace(/^-100/, '');
  return `https://t.me/c/${numericId}/${messageId}`;
}

// ── Main Entry Point ───────────────────────────────────────────────────────────

/**
 * Publish article to Telegram:
 * 1. Creates full article on Telegra.ph
 * 2. Posts cover + title + teaser + link to channel
 */
export async function publishToTelegram(article: ArticleWithCover): Promise<{ url: string }> {
  const content = article.content as ArticleContent;
  if (!content) throw new Error('Article has no content');

  const title = content.title || article.celebrityName;
  const coverImage = article.coverImages?.find((c: CoverImage) => c.isSelected)
    || article.coverImages?.[0];

  console.log(`📰 Publishing to Telegram: "${title}"`);
  console.log('============================================================');

  // 1. Get Telegraph token
  const telegraphToken = await getTelegraphToken();

  // 2. Build Telegraph content
  console.log('📝 Building Telegraph article...');
  const telegraphContent = await buildTelegraphContent(content, coverImage);
  console.log(`   ✅ Built ${telegraphContent.length} content nodes`);

  // 3. Create Telegraph page
  console.log('📄 Creating Telegraph page...');
  const telegraphUrl = await createTelegraphPage(telegraphToken, title, telegraphContent);
  console.log(`   ✅ Telegraph: ${telegraphUrl}`);

  // 4. Post to channel
  console.log('📢 Posting to Telegram channel...');
  const teaser = content.teaser || '';
  const messageUrl = await sendChannelPost(title, teaser, telegraphUrl, coverImage);
  console.log(`   ✅ Channel post: ${messageUrl}`);

  return { url: messageUrl };
}
