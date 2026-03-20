/**
 * VK Articles Publisher — HTTP API Client
 *
 * Публикация статей ВКонтакте через внутренний HTTP API.
 * Использует cookies из Chrome-расширения для авторизации (как Дзен).
 *
 * API Flow:
 * 1. Загрузка cookies из vk-state.json
 * 2. Получение CSRF hash из страницы редактора
 * 3. Загрузка фото через VK API (photos.getArticleUploadServer)
 * 4. Создание статьи через al_articles.php?act=save (article_id=0)
 * 5. Сохранение полного контента
 * 6. Публикация статьи (is_published=1)
 *
 * Block types в Article_text:
 * - type 1: Параграф
 * - type 2: Заголовок (title)
 * - type 4: Подзаголовок (h2)
 * - type 8: Цитата (blockquote)
 * - type 101: Изображение (с mediaId)
 *
 * Env vars:
 *   VK_ACCESS_TOKEN  — токен с правами photos + wall
 *   VK_GROUP_ID      — числовой ID группы (без минуса)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ArticleContent, CoverImage } from '@content-pipeline/shared';
import { ArticleWithCover, resolveImagePath } from './telegram';

// ── Config ─────────────────────────────────────────────────────────────────────

const SESSIONS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'vk-sessions')
  : path.resolve(__dirname, './sessions');

const VK_STATE_FILE = path.join(SESSIONS_DIR, 'vk-state.json');
const VK_API = 'https://api.vk.com/method';
const VK_API_VERSION = '5.199';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Types ──────────────────────────────────────────────────────────────────────

interface VkBlock {
  type: number;
  lines: { text: string }[];
  children: any[];
  mediaId?: string;
}

interface VkSaveResponse {
  articleId: number;
  title: string;
  url?: string;
}

// ── Cookie Management ──────────────────────────────────────────────────────────

/** Check if VK session cookies are available */
export function isVkSessionAvailable(): boolean {
  return fs.existsSync(VK_STATE_FILE);
}

/** Load VK cookies from session file */
function loadVkCookies(): string {
  if (!fs.existsSync(VK_STATE_FILE)) {
    throw new Error('No VK session found. Upload cookies via Settings page first.');
  }
  const session = JSON.parse(fs.readFileSync(VK_STATE_FILE, 'utf-8'));
  const cookies: { name: string; value: string; domain?: string }[] = session.cookies || [];

  // Filter VK-relevant cookies
  const vkCookies = cookies.filter(
    (c: any) => c.domain && (c.domain.includes('vk.com') || c.domain.includes('.vk.com'))
  );

  if (vkCookies.length === 0) {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }
  return vkCookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/** Browser-like headers for vk.com AJAX requests */
function vkBrowserHeaders(cookieHeader: string, referer?: string): Record<string, string> {
  return {
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': cookieHeader,
    'Origin': 'https://vk.com',
    'Pragma': 'no-cache',
    'Referer': referer || 'https://vk.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  };
}

// ── VK API Helper ──────────────────────────────────────────────────────────────

function getAccessToken(): string {
  const token = process.env.VK_ACCESS_TOKEN;
  if (!token) throw new Error('VK_ACCESS_TOKEN not set');
  return token;
}

function getGroupId(): string {
  const id = process.env.VK_GROUP_ID;
  if (!id) throw new Error('VK_GROUP_ID not set');
  return id;
}

async function vkApi(method: string, params: Record<string, string>): Promise<any> {
  const token = getAccessToken();
  const body = new URLSearchParams({
    ...params,
    access_token: token,
    v: VK_API_VERSION,
  });
  const res = await fetch(`${VK_API}/${method}`, { method: 'POST', body });
  const data = (await res.json()) as any;
  if (data.error) {
    throw new Error(`VK API ${method}: [${data.error.error_code}] ${data.error.error_msg}`);
  }
  return data.response;
}

// ── Group Info (cached) ────────────────────────────────────────────────────────

let _cachedScreenName: string | null = null;

async function getGroupScreenName(): Promise<string> {
  if (_cachedScreenName) return _cachedScreenName;
  const groupId = getGroupId();
  const resp = await vkApi('groups.getById', { group_ids: groupId });
  // Handle both old and new API response format
  const group = resp?.groups?.[0] || resp?.[0];
  const name = group?.screen_name || `club${groupId}`;
  _cachedScreenName = name;
  return name;
}

// ── CSRF Hash ──────────────────────────────────────────────────────────────────

/**
 * Fetch the VK articles editor hash needed for al_articles.php?act=save.
 *
 * VK loads the article editor as an AJAX overlay (z-layer).
 * The hash is NOT in the initial page HTML — it's returned via an internal
 * AJAX endpoint. We try multiple approaches:
 * 1. POST al_articles.php?act=edit (AJAX-style) — returns editor config with hash
 * 2. POST al_articles.php?act=stats_vars — lighter endpoint that may return hash
 * 3. Fetch full page HTML and parse (fallback)
 */
async function fetchEditorHash(cookieHeader: string): Promise<string> {
  const groupId = getGroupId();
  const screenName = await getGroupScreenName();

  console.log(`   🔑 Fetching article editor hash for /${screenName}...`);

  // ── Approach 1: AJAX call to al_articles.php
  // VK returns: {"payload":["CODE",["\\"HASH\\"",...]]}
  // payload[0] code "3" = access-check gate, payload[1][0] = session hash (hex, 18 chars)
  // We first try to pass the access check, then re-request editor data.
  const referer = `https://vk.com/${screenName}?z=article_edit-${groupId}_0`;

  // Step 1: Make initial request — VK will likely return code "3" (access check)
  console.log(`   📡 POST al_articles.php?act=edit...`);
  const editBody = new URLSearchParams({
    act: 'edit',
    al: '1',
    article_id: '0',
    article_owner_id: `-${groupId}`,
  });

  const editRes = await fetch('https://vk.com/al_articles.php', {
    method: 'POST',
    headers: vkBrowserHeaders(cookieHeader, referer),
    body: editBody,
  });

  if (!editRes.ok) {
    throw new Error(`al_articles.php returned HTTP ${editRes.status}`);
  }

  const editText = await editRes.text();
  console.log(`   📄 Response: ${editText.length} chars`);

  let editJson: any;
  try {
    editJson = JSON.parse(editText);
  } catch {
    console.log(`   ⚠️ Non-JSON response: ${editText.substring(0, 300)}`);
    throw new Error('al_articles.php returned non-JSON response');
  }

  const payloadCode = editJson?.payload?.[0];
  const payloadData = editJson?.payload?.[1];
  console.log(`   📋 Payload code: ${payloadCode}`);

  // If code "3": VK's access-check gate — payload[1] = [hash, redirect_url, token]
  if (payloadCode === '3' && Array.isArray(payloadData) && payloadData.length >= 3) {
    // Values are JSON-escaped strings like "\"abc123\""
    const stripQuotes = (s: string) => s.replace(/^"|"$/g, '');
    const acHash = stripQuotes(payloadData[0]);
    const acUrl = stripQuotes(payloadData[1]);
    const acToken = stripQuotes(payloadData[2]);

    console.log(`   🔐 Access check: hash=${acHash}, url_len=${acUrl.length}`);

    // Step 2: Complete the access check via al_ac.php
    console.log(`   📡 POST al_ac.php (access check)...`);
    const acBody = new URLSearchParams({
      act: 'a_check',
      al: '1',
      hash: acHash,
      to: acUrl,
      token: acToken,
    });

    const acRes = await fetch('https://vk.com/al_ac.php', {
      method: 'POST',
      headers: vkBrowserHeaders(cookieHeader, referer),
      body: acBody,
    });

    if (acRes.ok) {
      const acText = await acRes.text();
      console.log(`   📄 Access check response: ${acText.length} chars`);
      console.log(`   📋 AC body: ${acText.substring(0, 500)}`);

      // Step 3: Re-request the editor now that access check is complete
      console.log(`   📡 Re-requesting al_articles.php?act=edit...`);
      const retryRes = await fetch('https://vk.com/al_articles.php', {
        method: 'POST',
        headers: vkBrowserHeaders(cookieHeader, referer),
        body: new URLSearchParams({
          act: 'edit',
          al: '1',
          article_id: '0',
          article_owner_id: `-${groupId}`,
        }),
      });

      if (retryRes.ok) {
        const retryText = await retryRes.text();
        console.log(`   📄 Retry response: ${retryText.length} chars`);
        console.log(`   📋 Retry body start: ${retryText.substring(0, 500)}`);

        // Try to extract hash from the retry response
        const retryHash = extractHashFromResponse(retryText);
        if (retryHash) {
          console.log(`   🔑 Found hash after access check: ${retryHash}`);
          return retryHash;
        }
      }
    }

    // If access check didn't yield a different response, try using the session hash directly
    // The acHash (from payload[1][0]) is a session-level hex hash that may work for articles
    if (/^[a-f0-9]{14,22}$/.test(acHash)) {
      console.log(`   🔑 Using session hash from access-check: ${acHash}`);
      return acHash;
    }
  }

  // If payload code is not "3", try to extract hash directly from the response
  const directHash = extractHashFromResponse(editText);
  if (directHash) {
    console.log(`   🔑 Found hash directly: ${directHash}`);
    return directHash;
  }

  // ── Approach 2: Fetch the full group page and look for the hash in embedded data
  console.log('   📄 Fallback: fetching full page HTML...');
  const pageUrl = `https://vk.com/${screenName}?z=article_edit-${groupId}_0`;
  const res = await fetch(pageUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Cookie': cookieHeader,
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': USER_AGENT,
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch VK editor page: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  console.log(`   📄 Got page HTML: ${html.length} chars`);

  // Check if page is a login redirect
  if (html.includes('login_page') || html.includes('al_login')) {
    throw new Error('VK session expired — page redirected to login. Re-upload cookies in Settings.');
  }

  // Try to find hash in HTML
  const htmlHash = extractHashFromResponse(html);
  if (htmlHash) {
    console.log(`   🔑 Found hash in HTML: ${htmlHash}`);
    return htmlHash;
  }

  throw new Error(
    'Could not extract VK articles hash from any endpoint. ' +
      `Page size: ${html.length} chars`
  );
}

/** Extract a hex hash from VK's response text (JSON or HTML) */
function extractHashFromResponse(text: string): string | null {
  // Try parsing as JSON first — look in payload structure
  try {
    const json = JSON.parse(text);
    const payload = json?.payload;
    if (Array.isArray(payload) && payload.length >= 2) {
      // VK editor response may have hash in various positions
      const data = payload[1];
      if (typeof data === 'object' && data !== null) {
        // Could be {hash: "..."} or array with hash values
        if (data.hash && /^[a-f0-9]{14,22}$/.test(data.hash)) {
          return data.hash;
        }
        // Check nested objects
        for (const key of Object.keys(data)) {
          const val = data[key];
          if (typeof val === 'string' && /^[a-f0-9]{14,22}$/.test(val)) {
            return val;
          }
          if (typeof val === 'object' && val?.hash && /^[a-f0-9]{14,22}$/.test(val.hash)) {
            return val.hash;
          }
        }
      }
    }
  } catch {
    // Not JSON, continue with regex
  }

  // Regex patterns for hash extraction
  const patterns = [
    /articles_hash["']\s*:\s*["']([a-f0-9]{16,22})["']/i,
    /articleHash["':\s]+["']([a-f0-9]{16,22})["']/i,
    /"hash"\s*:\s*"([a-f0-9]{16,22})"\s*,\s*"?article/i,
    /Articles[^{]*\{[^}]*?hash["':\s]+["']([a-f0-9]{16,22})["']/i,
    /extend\(cur\s*,\s*\{[^}]*?hash["':\s]+["']([a-f0-9]{16,22})["']/i,
    /\\?"hash\\?"\s*:\s*\\?"([a-f0-9]{16,22})\\?"/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

// ── Photo Upload ───────────────────────────────────────────────────────────────

/** Resolve image path/URL and read as Buffer */
async function resolveAndReadImage(imagePath: string): Promise<Buffer> {
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    const res = await fetch(imagePath, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const resolved = resolveImagePath(imagePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Image not found: ${resolved}`);
  }
  return fs.readFileSync(resolved);
}

/** Upload multipart photo to VK upload URL */
async function uploadMultipart(
  uploadUrl: string,
  imageBuffer: Buffer,
  fieldName: string,
  filename: string
): Promise<any> {
  const ext = filename.toLowerCase().endsWith('.png') ? '.png' : '.jpg';
  const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const boundary = '----VKUpload' + crypto.randomBytes(8).toString('hex');

  const parts: Buffer[] = [];
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    )
  );
  parts.push(imageBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });

  return res.json();
}

/**
 * Upload photo for use in VK Article.
 * Tries photos.getArticleUploadServer first, falls back to wall photo.
 * Returns mediaId like "-178450295_457239107"
 */
async function uploadArticlePhoto(imagePath: string): Promise<string | null> {
  const groupId = getGroupId();

  try {
    const imageBuffer = await resolveAndReadImage(imagePath);
    console.log(`   📦 Image: ${(imageBuffer.length / 1024).toFixed(1)} KB`);

    // Approach 1: Try photos.getArticleUploadServer (undocumented VK API)
    try {
      const serverResp = await vkApi('photos.getArticleUploadServer', {
        group_id: groupId,
      });
      const uploadUrl = serverResp.upload_url;
      if (!uploadUrl) throw new Error('No upload_url in response');
      console.log('   📤 Got article upload server');

      // Upload photo
      const uploadData = await uploadMultipart(uploadUrl, imageBuffer, 'file', 'photo.jpg');

      // Save article photo
      const accessToken = getAccessToken();
      const saveBody = new URLSearchParams({
        upload_v2: '1',
        response_json: JSON.stringify(uploadData),
        access_token: accessToken,
        v: '5.274',
      });

      const saveRes = await fetch(
        `${VK_API}/photos.saveArticlePhoto?v=5.274&client_id=6287487`,
        { method: 'POST', body: saveBody }
      );
      const saveData = (await saveRes.json()) as any;

      if (saveData.error) {
        throw new Error(`photos.saveArticlePhoto: ${saveData.error.error_msg}`);
      }

      const photo = saveData.response[0];
      const mediaId = `${photo.owner_id}_${photo.id}`;
      console.log(`   ✅ Article photo: ${mediaId}`);
      return mediaId;
    } catch (err: any) {
      console.log(`   ⚠️ Article photo upload failed: ${err.message}`);
      console.log('   Trying wall photo as fallback...');
    }

    // Approach 2: Fallback to wall photo upload
    const wallServer = await vkApi('photos.getWallUploadServer', { group_id: groupId });
    const uploadData = await uploadMultipart(wallServer.upload_url, imageBuffer, 'photo', 'photo.jpg');

    if (!uploadData.photo || uploadData.photo === '[]') {
      console.error('   ⚠️ Wall photo upload returned empty');
      return null;
    }

    const saved = await vkApi('photos.saveWallPhoto', {
      group_id: groupId,
      server: String(uploadData.server),
      photo: uploadData.photo,
      hash: uploadData.hash,
    });

    if (!saved || saved.length === 0) return null;
    const photo = saved[0];
    const mediaId = `${photo.owner_id}_${photo.id}`;
    console.log(`   ✅ Wall photo (fallback): ${mediaId}`);
    return mediaId;
  } catch (err: any) {
    console.error(`   ⚠️ Photo upload failed: ${err.message}`);
    return null;
  }
}

// ── Transliteration & Slug ─────────────────────────────────────────────────────

const CYR_TO_LAT: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'j', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

function transliterate(text: string): string {
  return text
    .toLowerCase()
    .split('')
    .map(c => CYR_TO_LAT[c] ?? c)
    .join('');
}

function generateSlug(title: string): string {
  return transliterate(title)
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100);
}

// ── Content Building ───────────────────────────────────────────────────────────

/** Build VK Article blocks from ArticleContent */
function buildArticleBlocks(
  content: ArticleContent,
  coverMediaId: string | null,
  sectionMediaIds: Map<number, string>
): VkBlock[] {
  const blocks: VkBlock[] = [];
  const title = content.title || 'Untitled';

  // Title
  blocks.push({ type: 2, lines: [{ text: title }], children: [] });

  // Cover image (right after title, like in the HAR)
  if (coverMediaId) {
    blocks.push({ type: 101, lines: [{ text: '' }], children: [], mediaId: coverMediaId });
  }

  // Teaser
  if (content.teaser) {
    blocks.push({ type: 1, lines: [{ text: content.teaser }], children: [] });
  }

  // Sections
  for (let i = 0; i < content.sections.length; i++) {
    const section = content.sections[i];

    // Section heading
    blocks.push({ type: 4, lines: [{ text: section.heading }], children: [] });

    // Section image
    const mediaId = sectionMediaIds.get(i);
    if (mediaId) {
      blocks.push({ type: 101, lines: [{ text: '' }], children: [], mediaId });
    }

    // Paragraphs
    if (section.paragraph1) {
      blocks.push({ type: 1, lines: [{ text: section.paragraph1 }], children: [] });
    }
    if (section.paragraph2) {
      blocks.push({ type: 1, lines: [{ text: section.paragraph2 }], children: [] });
    }

    // Blockquote
    if (section.blockquote) {
      blocks.push({ type: 8, lines: [{ text: section.blockquote }], children: [] });
    }
  }

  // Conclusion
  if (content.conclusion) {
    blocks.push({
      type: 4,
      lines: [{ text: content.conclusion.heading || 'Итог' }],
      children: [],
    });
    blocks.push({ type: 1, lines: [{ text: content.conclusion.text }], children: [] });
  }

  // Hero quote
  if (content.heroQuote) {
    blocks.push({
      type: 8,
      lines: [{ text: `"${content.heroQuote.text}"` }],
      children: [],
    });
    if (content.heroQuote.author) {
      blocks.push({
        type: 8,
        lines: [{ text: `— ${content.heroQuote.author}` }],
        children: [],
      });
    }
  }

  // Bonus fact
  if (content.bonusFact) {
    blocks.push({ type: 4, lines: [{ text: '🎁 Бонусный факт:' }], children: [] });
    blocks.push({ type: 1, lines: [{ text: content.bonusFact }], children: [] });
  }

  return blocks;
}

// ── Article Save/Publish ───────────────────────────────────────────────────────

async function saveArticleRequest(
  cookieHeader: string,
  params: {
    articleText: VkBlock[];
    articleId: number;
    groupId: string;
    hash: string;
    slug: string;
    uuid: string;
    isPublished: boolean;
    coverPhotoId?: string;
  }
): Promise<VkSaveResponse> {
  const screenName = await getGroupScreenName();
  const referer =
    params.articleId === 0
      ? `https://vk.com/${screenName}?z=article_edit-${params.groupId}_0`
      : `https://vk.com/${screenName}?z=article_edit-${params.groupId}_${params.articleId}`;

  const body = new URLSearchParams({
    Article_text: JSON.stringify(params.articleText),
    act: 'save',
    al: '1',
    article_id: String(params.articleId),
    article_owner_id: `-${params.groupId}`,
    chunks_count: '0',
    cover_photo_id: params.coverPhotoId || '',
    hash: params.hash,
    is_published: params.isPublished ? '1' : '0',
    name: params.slug,
    session_duration: '60',
    uuid: params.uuid,
  });

  if (params.isPublished) {
    body.set('show_author', '1');
    body.set('show_on_author_page', '1');
    body.set('donut', '0');
    body.set('ofm', '0');
  }

  const res = await fetch('https://vk.com/al_articles.php?act=save', {
    method: 'POST',
    headers: vkBrowserHeaders(cookieHeader, referer),
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`al_articles.php save failed: ${res.status} — ${text.substring(0, 300)}`);
  }

  const data = (await res.json()) as any;

  // Response: {"payload":[0,[false, articleId, "title", ""|{url, ...}]]}
  const payload = data?.payload?.[1];
  if (!payload || !Array.isArray(payload)) {
    throw new Error('Unexpected save response: ' + JSON.stringify(data).substring(0, 500));
  }

  const articleId = payload[1];
  const title = payload[2] || '';
  const meta = payload[3]; // empty string for drafts, object for published

  let url: string | undefined;
  if (meta && typeof meta === 'object' && meta.url) {
    url = `https://vk.com${meta.url}`;
  }

  return { articleId, title, url };
}

// ── Main Entry Point ───────────────────────────────────────────────────────────

/**
 * Create and publish a VK Article.
 * Requires VK cookies (from Settings) and VK_ACCESS_TOKEN (for photo upload).
 */
export async function publishVkArticle(
  article: ArticleWithCover
): Promise<{ url: string }> {
  const content = article.content as ArticleContent;
  if (!content) throw new Error('Article has no content');

  const title = content.title || article.celebrityName;
  const groupId = getGroupId();
  const uuid = crypto.randomUUID();
  const slug = generateSlug(title);

  console.log(`📰 VK Article: "${title}"`);
  console.log('============================================================');

  // 1. Load cookies
  const cookieHeader = loadVkCookies();
  console.log('🍪 VK cookies loaded');

  // 2. Get CSRF hash from editor page
  console.log('🔑 Getting editor hash...');
  const hash = await fetchEditorHash(cookieHeader);

  // 3. Upload cover photo
  let coverMediaId: string | null = null;
  const coverImage =
    article.coverImages?.find((c: CoverImage) => c.isSelected) || article.coverImages?.[0];

  if (coverImage) {
    const coverSrc =
      coverImage.processedImageUrl || coverImage.localPath || coverImage.originalImageUrl;
    console.log('🖼️  Uploading cover photo...');
    coverMediaId = await uploadArticlePhoto(coverSrc);
  }

  // 4. Upload section images
  const sectionMediaIds = new Map<number, string>();
  for (let i = 0; i < content.sections.length; i++) {
    const section = content.sections[i] as any;
    if (section.imageUrl) {
      console.log(`🖼️  Uploading section ${i + 1} image...`);
      const mediaId = await uploadArticlePhoto(section.imageUrl);
      if (mediaId) sectionMediaIds.set(i, mediaId);
      await sleep(500); // Rate limiting
    }
  }

  // 5. Build article blocks
  const blocks = buildArticleBlocks(content, coverMediaId, sectionMediaIds);
  console.log(`📝 Built ${blocks.length} article blocks`);

  // 6. Create article (article_id=0 → VK returns new ID)
  console.log('📄 Creating article...');
  const titleOnlyBlocks: VkBlock[] = [
    { type: 2, lines: [{ text: title }], children: [] },
  ];

  const createResult = await saveArticleRequest(cookieHeader, {
    articleText: titleOnlyBlocks,
    articleId: 0,
    groupId,
    hash,
    slug,
    uuid,
    isPublished: false,
  });

  const articleId = createResult.articleId;
  console.log(`   ✅ Article created: ID ${articleId}`);

  // 7. Save full content (draft)
  console.log('💾 Saving full article content...');
  await sleep(1000);
  await saveArticleRequest(cookieHeader, {
    articleText: blocks,
    articleId,
    groupId,
    hash,
    slug,
    uuid,
    isPublished: false,
  });
  console.log('   ✅ Content saved');

  // 8. Publish
  console.log('🚀 Publishing article...');
  await sleep(1000);
  const publishResult = await saveArticleRequest(cookieHeader, {
    articleText: blocks,
    articleId,
    groupId,
    hash,
    slug,
    uuid,
    isPublished: true,
    coverPhotoId: coverMediaId || undefined,
  });

  // 9. Build article URL
  const articleUrl =
    publishResult.url || `https://vk.com/@${await getGroupScreenName()}-${slug}`;

  console.log(`   ✅ VK Article published: ${articleUrl}`);
  return { url: articleUrl };
}
