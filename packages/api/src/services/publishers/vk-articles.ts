/**
 * VK Articles Publisher — HTTP API Client
 *
 * Публикация статей ВКонтакте через внутренний HTTP API.
 * Использует cookies из Chrome-расширения для авторизации (как Дзен).
 *
 * API Flow (discovered via HAR analysis 2026-03-21):
 * 1. Загрузка cookies из vk-state.json
 * 2. POST al_articles.php?act=open_editor → saveDraftHash + uuid + photoUploadUrl
 * 3. Загрузка фото через полученный photoUploadUrl + photos.saveArticlePhoto
 * 4. Создание статьи через al_articles.php?act=save (article_id=0)
 * 5. Публикация статьи (is_published=1)
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

// ── Editor Session (open_editor) ───────────────────────────────────────────────

/**
 * Open VK article editor via internal API.
 *
 * POST al_articles.php?act=open_editor returns:
 * - payload[1][1].access_hash
 * - payload[1][5].saveDraftHash — CSRF hash for save requests
 * - payload[1][5].uuid — session UUID
 * - payload[1][5].photoUploadOptions.url — direct photo upload URL with JWT
 */
interface EditorSession {
  saveDraftHash: string;
  uuid: string;
  photoUploadUrl: string | null;
  accessHash: string | null;
}

async function openEditor(cookieHeader: string): Promise<EditorSession> {
  const groupId = getGroupId();
  const screenName = await getGroupScreenName();
  const referer = `https://vk.com/${screenName}?z=article_edit-${groupId}_0`;

  console.log(`   📡 POST al_articles.php?act=open_editor`);

  const baseParams: Record<string, string> = {
    act: 'open_editor',
    al: '1',
    article_id: '0',
    article_owner_id: `-${groupId}`,
    from_post_convert: '0',
    post_data_medias: '',
  };

  // First attempt
  let data = await postOpenEditor(cookieHeader, referer, baseParams);
  let responseCode = data?.payload?.[0];

  // Handle code-3 access-check gate: VK wants IP confirmation.
  // Flow: extract credentials → confirm via al_login.php → retry with ip_h
  if (responseCode === '3' || responseCode === 3) {
    const gate = data.payload[1];
    if (!Array.isArray(gate) || gate.length < 3) {
      throw new Error(
        `VK code-3 gate but unexpected payload[1] structure: ${JSON.stringify(gate).substring(0, 300)}`
      );
    }

    // Values come wrapped in literal quotes: "\"abc\"" → abc
    const stripQuotes = (s: string) => s.replace(/^"|"$/g, '');
    const ipH = stripQuotes(gate[0]);
    const to = stripQuotes(gate[1]);
    const lgH = stripQuotes(gate[2]);

    console.log(`   🔐 Code-3 access-check gate detected`);
    console.log(`   📋 ip_h: ${ipH}`);
    console.log(`   📋 to: ${to}`);

    // Step 1: Confirm the security check via al_login.php
    await resolveSecurityCheck(cookieHeader, ipH, to, lgH);

    // Step 2: Retry open_editor with ip_h
    console.log(`   🔄 Retrying open_editor with ip_h...`);
    data = await postOpenEditor(cookieHeader, referer, { ...baseParams, ip_h: ipH });
    responseCode = data?.payload?.[0];

    if (responseCode === '3' || responseCode === 3) {
      const raw = JSON.stringify(data).substring(0, 500);
      throw new Error(
        `VK returned code-3 again after security check confirmation. ` +
        `Session cookies may be expired or VK requires phone verification. ` +
        `Re-upload fresh cookies. Response: ${raw}`
      );
    }
  }

  if (responseCode !== 0) {
    throw new Error(`Unexpected open_editor response code: ${responseCode}. Full: ${JSON.stringify(data).substring(0, 500)}`);
  }

  const payload = data.payload[1];
  if (!Array.isArray(payload) || payload.length < 6) {
    throw new Error(`Unexpected open_editor payload structure: ${JSON.stringify(payload).substring(0, 500)}`);
  }

  const articleData = payload[1] || {};
  const accessHash = articleData.access_hash || null;

  const editorConfig = payload[5] || {};
  const saveDraftHash = editorConfig.saveDraftHash;
  const uuid = editorConfig.uuid;
  const photoUploadUrl = editorConfig.photoUploadOptions?.url || null;

  if (!saveDraftHash) {
    throw new Error(
      `No saveDraftHash in open_editor response. Config keys: ${Object.keys(editorConfig).join(', ')}. ` +
      `Full config preview: ${JSON.stringify(editorConfig).substring(0, 500)}`
    );
  }

  console.log(`   ✅ saveDraftHash: ${saveDraftHash}`);
  console.log(`   📋 uuid: ${uuid}`);
  console.log(`   📋 accessHash: ${accessHash || 'N/A'}`);
  console.log(`   📋 photoUploadUrl: ${photoUploadUrl ? 'obtained' : 'N/A'}`);

  return { saveDraftHash, uuid, photoUploadUrl, accessHash };
}

/** Low-level POST to al_articles.php?act=open_editor */
async function postOpenEditor(
  cookieHeader: string,
  referer: string,
  params: Record<string, string>,
): Promise<any> {
  const res = await fetch('https://vk.com/al_articles.php?act=open_editor', {
    method: 'POST',
    headers: vkBrowserHeaders(cookieHeader, referer),
    body: new URLSearchParams(params),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`open_editor failed: ${res.status} — ${text.substring(0, 300)}`);
  }

  return (await res.json()) as any;
}

/**
 * Resolve VK's code-3 IP security check.
 *
 * When cookies are used from a new IP, VK requires confirmation via al_login.php.
 * VK's browser JS shows a security check modal; we replicate that flow with HTTP.
 *
 * Flow:
 * 1. POST al_login.php with act=security_check to load the check
 * 2. POST al_login.php again to confirm (auto-approve the IP)
 * 3. If phone verification is required, throw — can't automate that
 */
async function resolveSecurityCheck(
  cookieHeader: string,
  ipH: string,
  to: string,
  lgH: string,
): Promise<void> {
  console.log(`   🔐 Confirming security check via al_login.php...`);

  // Step 1: Load security check page
  const loadRes = await fetch('https://vk.com/al_login.php', {
    method: 'POST',
    headers: vkBrowserHeaders(cookieHeader, 'https://vk.com/'),
    body: new URLSearchParams({
      act: 'security_check',
      al: '1',
      al_page: '3',
      hash: ipH,
      to,
      lg_h: lgH,
    }),
  });

  const loadText = await loadRes.text();
  console.log(`   📋 Security check load: ${loadRes.status}, ${loadText.length} chars`);
  console.log(`   📋 Preview: ${loadText.substring(0, 500)}`);

  // Try to parse as JSON (VK AJAX response)
  let loadJson: any = null;
  try {
    loadJson = JSON.parse(loadText);
    const code = loadJson?.payload?.[0];
    console.log(`   📋 Security check response code: ${code}`);
    if (code === 0) {
      console.log(`   ✅ Security check auto-confirmed (code 0)`);
      return;
    }
  } catch {
    // HTML response
  }

  // Check if phone verification is required (can't automate)
  if (loadText.includes('security_code') || loadText.includes('enter_code') ||
      loadText.includes('Введите код') || loadText.includes('Подтвердите')) {
    console.log(`   📋 Full response for debugging: ${loadText.substring(0, 2000)}`);
  }

  // Step 2: Try to confirm the check
  console.log(`   🔐 Sending security confirmation...`);
  const confirmRes = await fetch('https://vk.com/al_login.php', {
    method: 'POST',
    headers: vkBrowserHeaders(cookieHeader, 'https://vk.com/login?act=security_check'),
    body: new URLSearchParams({
      act: 'security_check',
      al: '1',
      hash: ipH,
      to,
      lg_h: lgH,
      approve: '1',
    }),
  });

  const confirmText = await confirmRes.text();
  console.log(`   📋 Confirm response: ${confirmRes.status}, ${confirmText.length} chars`);
  console.log(`   📋 Preview: ${confirmText.substring(0, 500)}`);

  try {
    const confirmJson = JSON.parse(confirmText);
    const code = confirmJson?.payload?.[0];
    console.log(`   📋 Confirm code: ${code}`);
    if (code === 0) {
      console.log(`   ✅ Security check confirmed`);
      return;
    }
  } catch {
    // Not JSON
  }

  // Step 3: Alternative — try via /login page GET (browser-style navigation)
  console.log(`   🔐 Trying GET /login?act=security_check...`);
  const loginRes = await fetch(
    `https://vk.com/login?act=security_check&to=${encodeURIComponent(to)}&hash=${encodeURIComponent(ipH)}`,
    {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      redirect: 'follow',
    },
  );

  const loginHtml = await loginRes.text();
  console.log(`   📋 Login page: ${loginRes.status}, ${loginHtml.length} chars, url: ${loginRes.url}`);

  // Look for the approve/confirm form action
  const approveMatch = loginHtml.match(/action="([^"]*security_check[^"]*)"/);
  if (approveMatch) {
    console.log(`   📋 Found form action: ${approveMatch[1]}`);
  }

  // Extract any hidden form fields (hash, lg_h, etc.)
  const hashMatch = loginHtml.match(/name="hash"\s+value="([^"]+)"/);
  const codeMatch = loginHtml.match(/name="code"/);

  if (codeMatch) {
    throw new Error(
      `VK requires phone/SMS code verification for this IP. ` +
      `Cannot automate this step. To fix: open https://vk.com from the Railway server ` +
      `(or use the same IP/VPN when exporting cookies).`
    );
  }

  // Try to POST the approve form
  if (hashMatch) {
    console.log(`   🔐 Submitting approve form with hash: ${hashMatch[1]}`);
    const approveRes = await fetch('https://vk.com/login?act=security_check', {
      method: 'POST',
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': loginRes.url,
      },
      body: new URLSearchParams({
        hash: hashMatch[1],
        to,
        al: '1',
      }),
      redirect: 'follow',
    });
    console.log(`   📋 Approve result: ${approveRes.status}, url: ${approveRes.url}`);
    const approveText = await approveRes.text();
    console.log(`   📋 Approve preview: ${approveText.substring(0, 300)}`);
  }

  // We've done our best — the retry in openEditor will tell if it worked
  console.log(`   📋 Security check flow completed, proceeding to retry...`);
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
async function uploadArticlePhoto(
  imagePath: string,
  photoUploadUrl: string | null = null,
  cookieHeader: string | null = null,
): Promise<string | null> {
  const groupId = getGroupId();

  try {
    const imageBuffer = await resolveAndReadImage(imagePath);
    console.log(`   📦 Image: ${(imageBuffer.length / 1024).toFixed(1)} KB`);

    // Preferred: use the JWT article photo upload URL from open_editor
    if (photoUploadUrl) {
      try {
        const uploadData = await uploadMultipart(photoUploadUrl, imageBuffer, 'file', 'photo.jpg');

        // Save the uploaded photo via photos.saveArticlePhoto
        const saved = await vkApi('photos.saveArticlePhoto', {
          group_id: groupId,
          server: String(uploadData.server ?? ''),
          photo: uploadData.photo ?? '',
          hash: uploadData.hash ?? '',
        });

        if (saved && saved.length > 0) {
          const photo = saved[0];
          const mediaId = `${photo.owner_id}_${photo.id}`;
          console.log(`   ✅ Article photo: ${mediaId}`);
          return mediaId;
        }
        console.log(`   ⚠️ saveArticlePhoto returned empty, falling back to wall photo`);
      } catch (err: any) {
        console.log(`   ⚠️ Article photo upload failed (${err.message?.substring(0, 100)}), falling back to wall photo`);
      }
    }

    // Fallback: upload as wall photo
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

  // ── CRITICAL: Detect code "3" access-check gate ──
  // If VK returns code "3", the hash was wrong or the session needs verification.
  // The payload contains [hash, redirect_url, token] — NOT article data!
  const responseCode = data?.payload?.[0];
  if (responseCode === '3' || responseCode === 3) {
    const raw = JSON.stringify(data).substring(0, 300);
    throw new Error(
      `VK returned access-check gate (code 3) for save request. ` +
        `The editor hash is likely wrong or session needs browser verification. ` +
        `Response: ${raw}`
    );
  }

  // Response: {"payload":[0,[false, articleId, "title", ""|{url, ...}]]}
  const payload = data?.payload?.[1];
  if (!payload || !Array.isArray(payload)) {
    throw new Error('Unexpected save response: ' + JSON.stringify(data).substring(0, 500));
  }

  const articleId = payload[1];
  const title = payload[2] || '';
  const meta = payload[3]; // empty string for drafts, object for published

  // Validate that articleId is a number, not a base64 string
  if (typeof articleId !== 'number') {
    throw new Error(
      `Unexpected article ID type: ${typeof articleId} = ${JSON.stringify(articleId).substring(0, 100)}. ` +
        `Expected a number. VK may have returned an error response.`
    );
  }

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
  const slug = generateSlug(title);

  console.log(`📰 VK Article: "${title}"`);
  console.log('============================================================');

  // 1. Load cookies
  const cookieHeader = loadVkCookies();
  console.log('🍪 VK cookies loaded');

  // 2. Open editor session — returns CSRF hash, uuid, photo upload URL
  console.log('🔑 Opening editor session...');
  const editor = await openEditor(cookieHeader);
  const hash = editor.saveDraftHash;
  const uuid = editor.uuid;
  const activeCookieHeader = cookieHeader;

  // 3. Upload cover photo
  let coverMediaId: string | null = null;
  const coverImage =
    article.coverImages?.find((c: CoverImage) => c.isSelected) || article.coverImages?.[0];

  if (coverImage) {
    const coverSrc =
      coverImage.processedImageUrl || coverImage.localPath || coverImage.originalImageUrl;
    console.log('🖼️  Uploading cover photo...');
    coverMediaId = await uploadArticlePhoto(coverSrc, editor.photoUploadUrl, activeCookieHeader);
  }

  // 4. Upload section images
  const sectionMediaIds = new Map<number, string>();
  for (let i = 0; i < content.sections.length; i++) {
    const section = content.sections[i] as any;
    if (section.imageUrl) {
      console.log(`🖼️  Uploading section ${i + 1} image...`);
      const mediaId = await uploadArticlePhoto(section.imageUrl, editor.photoUploadUrl, activeCookieHeader);
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

  const createResult = await saveArticleRequest(activeCookieHeader, {
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
  await saveArticleRequest(activeCookieHeader, {
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
  const publishResult = await saveArticleRequest(activeCookieHeader, {
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
