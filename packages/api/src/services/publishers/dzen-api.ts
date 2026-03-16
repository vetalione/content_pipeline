/**
 * Яндекс Дзен (dzen.ru) Publisher — HTTP API Client
 * 
 * Альтернативная реализация публикации через прямые HTTP-запросы
 * к внутренним API Дзен, без Playwright/браузерной автоматизации.
 * 
 * API Flow:
 * 1. GET  /media-api/csrf-token                        → CSRF токен
 * 2. POST /editor-api/v2/add-publication                → Создать черновик
 * 3. POST /editor-api/v2/add-image (multipart)          → Загрузить картинки
 * 4. POST /editor-api/v2/update-publication-content-and-publish → Опубликовать
 * 
 * Контент передаётся в формате Draft.js contentState (JSON).
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ArticleContent, CoverImage } from '@content-pipeline/shared';

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────────────

type ArticleWithCover = {
  id: string;
  celebrityName: string;
  content: ArticleContent | any;
  coverImages?: CoverImage[];
  coverImage?: CoverImage;
  [key: string]: any;
};

interface DzenApiPublishResult {
  success: boolean;
  url?: string;
  error?: string;
}

interface DzenApiPublishOptions {
  draft?: boolean;
}

interface DraftBlock {
  key: string;
  text: string;
  type: 'unstyled' | 'header-two' | 'blockquote' | 'atomic:image';
  depth: number;
  inlineStyleRanges: any[];
  entityRanges: any[];
  data: Record<string, any>;
}

// ── Config ─────────────────────────────────────────────────────────────────────

const SESSIONS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'dzen-sessions')
  : path.resolve(__dirname, './sessions');

const DZEN_STATE_FILE = path.join(SESSIONS_DIR, 'dzen-state.json');
const DZEN_FP_FILE = path.join(SESSIONS_DIR, 'dzen-fp-token.txt');
const BASE_URL = 'https://dzen.ru';
const PUBLISHER_ID = '5c0c260beb86bc00a9389420';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Generate a random client request ID (hex, like Dzen uses) */
function clientRid(): string {
  return Array.from({ length: 7 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
}

/** Generate a random Draft.js block key (5 alphanumeric chars) */
function blockKey(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Resolve web-served paths (/images/..., /covers/...) to actual filesystem paths */
function resolveImagePath(imagePath: string): string {
  const storageBase = process.env.STORAGE_PATH || process.cwd();
  // Web-served paths need storageBase prefix
  if (imagePath.startsWith('/images/')) {
    return path.join(storageBase, imagePath);
  }
  if (imagePath.startsWith('/covers/')) {
    return path.join(storageBase, imagePath);
  }
  // Already absolute or a URL — use as-is
  return imagePath;
}

/** Load cookies from Playwright session file and return as cookie header string */
function loadCookies(): string {
  if (!fs.existsSync(DZEN_STATE_FILE)) {
    throw new Error('No Dzen session found. Upload cookies via Settings page first.');
  }
  const session = JSON.parse(fs.readFileSync(DZEN_STATE_FILE, 'utf-8'));
  const cookies: { name: string; value: string }[] = session.cookies || [];
  
  // Filter only dzen.ru and yandex cookies
  const relevant = cookies.filter(c =>
    c.name && c.value &&
    (c.name === 'Session_id' || c.name === 'yandex_login' ||
     c.name === 'sessionid2' || c.name === 'yandexuid' ||
     c.name === 'i' || c.name === 'yp' || c.name === 'ys' ||
     c.name === 'L' || c.name === '_yasc' ||
     c.name === 'zen_sso' || c.name === 'dzen_sso' ||
     c.name === 'zen_session_id' || c.name === 'dzen_sess_id' ||
     c.name.startsWith('_ym') || c.name === 'is_gdpr' ||
     c.name === 'gdpr' || c.name === 'is_gdpr_b')
  );
  
  if (relevant.length === 0) {
    // Fallback: send all cookies for the domains
    const domainCookies = cookies.filter((c: any) =>
      c.domain && (c.domain.includes('dzen.ru') || c.domain.includes('yandex.ru') || c.domain.includes('.yandex.ru'))
    );
    return domainCookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
  }
  
  return relevant.map(c => `${c.name}=${c.value}`).join('; ');
}

/** Load X-FP-Token (fingerprint) from saved file or env var */
function loadFpToken(): string {
  // Try env var first
  if (process.env.DZEN_FP_TOKEN) {
    return process.env.DZEN_FP_TOKEN;
  }
  // Try file
  if (fs.existsSync(DZEN_FP_FILE)) {
    return fs.readFileSync(DZEN_FP_FILE, 'utf-8').trim();
  }
  return '';
}

/** Common browser-like headers for all Dzen API requests */
function browserHeaders(cookieHeader: string, csrfToken?: string, referer?: string): Record<string, string> {
  const fpToken = loadFpToken();
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Cookie': cookieHeader,
    'Host': 'dzen.ru',
    'Origin': BASE_URL,
    'Pragma': 'no-cache',
    'Referer': referer || `${BASE_URL}/profile/editor/id/${PUBLISHER_ID}`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': USER_AGENT,
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  };
  if (csrfToken) {
    headers['X-Csrf-Token'] = csrfToken;
  }
  if (fpToken) {
    headers['X-FP-Token'] = fpToken;
  }
  return headers;
}

// ── API Methods ────────────────────────────────────────────────────────────────

/** Get CSRF token from Dzen */
async function getCsrfToken(cookieHeader: string): Promise<string> {
  console.log('🔑 Getting CSRF token...');
  
  const res = await fetch(`${BASE_URL}/media-api/csrf-token`, {
    headers: browserHeaders(cookieHeader),
  });
  
  if (!res.ok) {
    throw new Error(`CSRF token request failed: ${res.status} ${res.statusText}`);
  }
  
  const data = await res.json() as { result: string };
  console.log('   ✅ Got CSRF token');
  return data.result;
}

/** Create a new article draft, returns publication ID */
async function createDraft(cookieHeader: string, csrfToken: string): Promise<string> {
  console.log('📄 Creating article draft...');
  
  const res = await fetch(
    `${BASE_URL}/editor-api/v2/add-publication?publisherId=${PUBLISHER_ID}&clientRid=${clientRid()}&clid=320`,
    {
      method: 'POST',
      headers: {
        ...browserHeaders(cookieHeader, csrfToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: '',
        publisherId: PUBLISHER_ID,
        publicationType: 'article',
        fp: '',
      }),
    }
  );
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create draft failed: ${res.status} ${text.substring(0, 200)}`);
  }
  
  const data = await res.json() as any;
  const pubId = data.id || data.publicationId || data._id;
  if (!pubId) {
    throw new Error('Create draft response missing publication ID: ' + JSON.stringify(data).substring(0, 300));
  }
  
  console.log(`   ✅ Draft created: ${pubId}`);
  return pubId;
}

/** Upload an image to the publication, returns image ID */
async function uploadImage(
  cookieHeader: string,
  csrfToken: string,
  publicationId: string,
  imageSource: string | Buffer,
  filename = 'image.jpg'
): Promise<string> {
  console.log(`🖼️  Uploading image: ${typeof imageSource === 'string' ? imageSource.substring(0, 60) : 'buffer'}...`);
  
  let imageBuffer: Buffer;
  let contentType = 'image/jpeg';

  if (typeof imageSource === 'string') {
    if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
      // Download from URL
      const imgRes = await fetch(imageSource);
      if (!imgRes.ok) {
        throw new Error(`Failed to download image: ${imgRes.status} from ${imageSource.substring(0, 80)}`);
      }
      imageBuffer = Buffer.from(await imgRes.arrayBuffer());
      // Detect content type from response or URL
      const ct = imgRes.headers.get('content-type');
      if (ct) contentType = ct;
      if (imageSource.includes('.png')) contentType = 'image/png';
      if (imageSource.includes('.webp')) contentType = 'image/webp';
    } else {
      // Local file path — resolve web-served paths to filesystem
      const resolved = resolveImagePath(imageSource);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Image file not found: ${resolved} (original: ${imageSource})`);
      }
      imageBuffer = fs.readFileSync(resolved);
      if (resolved.endsWith('.png')) contentType = 'image/png';
      if (resolved.endsWith('.webp')) contentType = 'image/webp';
    }
  } else {
    imageBuffer = imageSource;
  }

  console.log(`   📦 Image size: ${(imageBuffer.length / 1024).toFixed(1)} KB, type: ${contentType}`);

  const uploadUrl = `${BASE_URL}/editor-api/v2/add-image?publicationId=${publicationId}&publisherId=${PUBLISHER_ID}&clientRid=${clientRid()}`;
  const editReferer = `${BASE_URL}/profile/editor/id/${PUBLISHER_ID}/${publicationId}/edit`;

  // Write image to temp file for curl
  const tmpFile = path.join('/tmp', `dzen_upload_${Date.now()}_${filename}`);
  fs.writeFileSync(tmpFile, imageBuffer);
  
  const allHeaders = browserHeaders(cookieHeader, csrfToken, editReferer);
  
  // Build curl args — uses OpenSSL TLS (different fingerprint from Node.js)
  const curlArgs = [
    '-v',                            // verbose — show TLS handshake details
    '--max-time', '60',              // timeout 60s
    '--http1.1',                     // Force HTTP/1.1 (matches browser HAR)
    '-X', 'POST',
    '-F', `file=@${tmpFile};type=${contentType};filename=${filename}`,
  ];
  
  // Add all browser headers
  for (const [key, value] of Object.entries(allHeaders)) {
    if (key === 'Accept-Encoding') continue; // let curl handle
    curlArgs.push('-H', `${key}: ${value}`);
  }
  
  curlArgs.push(uploadUrl);
  
  console.log(`   🔧 Upload URL: ${uploadUrl}`);
  console.log(`   🔧 Using curl -v --http1.1 (verbose, forced HTTP/1.1)`);
  
  let responseBody: string;
  try {
    const { stdout, stderr } = await execFileAsync('curl', curlArgs, { maxBuffer: 10 * 1024 * 1024 });
    // curl -v outputs connection info to stderr
    if (stderr) console.log(`   🔧 curl verbose:\n${stderr.substring(0, 1500)}`);
    responseBody = stdout;
    console.log(`   📄 Response body (first 500 chars): ${responseBody.substring(0, 500)}`);
  } catch (curlErr: any) {
    console.log(`   ❌ curl failed: ${curlErr.message?.substring(0, 200)}`);
    // With -v, stderr contains the TLS handshake and connection details
    console.log(`   ❌ curl verbose output:\n${curlErr.stderr?.substring(0, 2000)}`);
    throw new Error(`Network error uploading image via curl: ${curlErr.stderr?.substring(0, 300) || curlErr.message}`);
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch {}
  }
  
  let data: any;
  try {
    data = JSON.parse(responseBody);
  } catch {
    throw new Error(`Invalid JSON response from curl: ${responseBody.substring(0, 300)}`);
  }
  
  const imageId = data.id || data.imageId || data._id;
  if (!imageId) {
    throw new Error('Image upload response missing ID: ' + JSON.stringify(data).substring(0, 300));
  }
  
  console.log(`   ✅ Image uploaded: ${imageId}`);
  return imageId;
}

/** Publish article with full content */
async function publishContent(
  cookieHeader: string,
  csrfToken: string,
  publicationId: string,
  blocks: DraftBlock[],
  preview: { title: string; snippet: string; imageId?: string },
  draft = false
): Promise<void> {
  const endpoint = draft 
    ? 'update-publication-content'
    : 'update-publication-content-and-publish';
  
  console.log(`📤 ${draft ? 'Saving draft' : 'Publishing'}...`);
  
  const contentState = JSON.stringify({
    blocks,
    entityMap: {},
  });
  
  const previewObj: any = {
    title: preview.title,
    snippet: preview.snippet,
  };
  if (preview.imageId) {
    previewObj.image = { id: preview.imageId };
  }
  
  const body: any = {
    id: publicationId,
    preview: previewObj,
    snippetFrozen: true,
    hasNativeAds: false,
    commentsFlagState: 'on',
    delayedPublicationFlagState: 'off',
    visibleComments: 'visible',
    visibilityType: 'all',
    premiumTariffs: [],
    customCommentsTitle: '',
    articleContent: { contentState },
    tagsInput: { tags: [], detectedTagsShown: false },
    fp: '',
  };
  
  const editReferer = `${BASE_URL}/profile/editor/id/${PUBLISHER_ID}/${publicationId}/edit`;
  const res = await fetch(
    `${BASE_URL}/editor-api/v2/${endpoint}?publisherId=${PUBLISHER_ID}&clientRid=${clientRid()}`,
    {
      method: 'POST',
      headers: {
        ...browserHeaders(cookieHeader, csrfToken, editReferer),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  
  if (!res.ok) {
    const text = await res.text();
    if (text.includes('captcha-required-error')) {
      throw new Error('Captcha required by Dzen — session may need refresh or too many requests');
    }
    throw new Error(`${draft ? 'Save' : 'Publish'} failed: ${res.status} ${text.substring(0, 300)}`);
  }
  
  console.log(`   ✅ ${draft ? 'Draft saved' : 'Published'}`);
}

// ── Content Builder ────────────────────────────────────────────────────────────

/** Build Draft.js blocks from ArticleContent, uploading images along the way */
async function buildBlocks(
  content: ArticleContent,
  coverImage: CoverImage | undefined,
  cookieHeader: string,
  csrfToken: string,
  publicationId: string
): Promise<{ blocks: DraftBlock[]; coverImageId?: string }> {
  const blocks: DraftBlock[] = [];
  let coverImageId: string | undefined;

  // Helper to create a block
  const block = (type: DraftBlock['type'], text: string, data: Record<string, any> = {}): DraftBlock => ({
    key: blockKey(),
    text,
    type,
    depth: 0,
    inlineStyleRanges: [],
    entityRanges: [],
    data,
  });

  // 1. Title — always first block in the editor
  if (content.title) {
    blocks.push(block('header-two', content.title));
  }

  // 2. Cover image (обложка)
  if (coverImage) {
    // Try localPath first (actual filesystem path), then processedImageUrl, then originalImageUrl
    const candidates = [
      coverImage.localPath,
      coverImage.processedImageUrl,
      coverImage.originalImageUrl,
    ].filter(Boolean) as string[];

    for (const imgSource of candidates) {
      try {
        console.log(`   🔍 Trying cover source: ${imgSource.substring(0, 80)}`);
        coverImageId = await uploadImage(cookieHeader, csrfToken, publicationId, imgSource, 'cover.jpg');
        blocks.push(block('atomic:image', '', { image: { id: coverImageId } }));
        break; // success — stop trying
      } catch (err: any) {
        console.error(`   ⚠️ Cover upload failed (${imgSource.substring(0, 50)}):`, err.message);
        await sleep(500);
      }
    }
    if (!coverImageId) {
      console.error('   ❌ All cover sources failed');
    }
  }

  // 3. Teaser / intro
  if (content.teaser) {
    blocks.push(block('unstyled', content.teaser));
  }

  // 4. Sections: heading → image → paragraph1 → paragraph2 → blockquote
  for (const section of content.sections) {
    // Section heading (H2)
    blocks.push(block('header-two', section.heading));

    // Section image
    if (section.imageUrl) {
      try {
        await sleep(500); // Delay between uploads to avoid rate limiting
        const imgId = await uploadImage(
          cookieHeader, csrfToken, publicationId,
          section.imageUrl,
          `section-${section.number}.jpg`
        );
        blocks.push(block('atomic:image', '', { image: { id: imgId } }));
      } catch (err: any) {
        console.error(`   ⚠️ Section ${section.number} image failed:`, err.message);
      }
    }

    // Paragraph 1
    if (section.paragraph1) {
      blocks.push(block('unstyled', section.paragraph1));
    }

    // Paragraph 2
    if (section.paragraph2) {
      blocks.push(block('unstyled', section.paragraph2));
    }

    // Blockquote
    if (section.blockquote) {
      blocks.push(block('blockquote', section.blockquote));
    }
  }

  // 5. Conclusion
  if (content.conclusion) {
    blocks.push(block('header-two', content.conclusion.heading));
    blocks.push(block('unstyled', content.conclusion.text));
  }

  // 6. Hero quote
  if (content.heroQuote) {
    blocks.push(block('blockquote', `"${content.heroQuote.text}" — ${content.heroQuote.author}`));
  }

  // 7. Bonus fact
  if (content.bonusFact) {
    blocks.push(block('header-two', '🎁 Бонусный факт:'));
    blocks.push(block('unstyled', content.bonusFact));
  }

  // 8. CTA
  if (content.cta) {
    blocks.push(block('unstyled', content.cta));
  }

  // 9. Brand ending
  if (content.brandEnding) {
    blocks.push(block('unstyled', content.brandEnding));
  }

  return { blocks, coverImageId };
}

// ── Main Entry Point ───────────────────────────────────────────────────────────

/**
 * Publish article to Dzen via HTTP API (no browser needed).
 * Drop-in replacement for publishToDzen from dzen.ts.
 */
export async function publishToDzenApi(
  article: ArticleWithCover,
  options: DzenApiPublishOptions = {}
): Promise<DzenApiPublishResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📰 Publishing to Dzen (API): "${article.celebrityName}"`);
  console.log(`${'='.repeat(60)}\n`);

  const content = article.content as ArticleContent | null;
  if (!content) {
    return { success: false, error: 'Article has no content' };
  }

  try {
    // Step 1: Load cookies & get CSRF token
    const cookieHeader = loadCookies();
    const csrfToken = await getCsrfToken(cookieHeader);

    // Step 2: Create draft
    const publicationId = await createDraft(cookieHeader, csrfToken);

    // Step 3: Build content blocks (uploads images during building)
    const coverImage = article.coverImages?.[0] || article.coverImage;
    const { blocks, coverImageId } = await buildBlocks(
      content, coverImage,
      cookieHeader, csrfToken, publicationId
    );

    console.log(`📊 Built ${blocks.length} blocks`);
    const typeCounts: Record<string, number> = {};
    for (const b of blocks) {
      typeCounts[b.type] = (typeCounts[b.type] || 0) + 1;
    }
    console.log(`   Types: ${Object.entries(typeCounts).map(([t, n]) => `${t}=${n}`).join(', ')}`);

    // Step 4: Build preview snippet (first ~500 chars of text)
    const textBlocks = blocks.filter(b => b.type === 'unstyled');
    const snippet = textBlocks.map(b => b.text).join(' ').substring(0, 500);

    // Step 5: Publish (or save as draft)
    await publishContent(
      cookieHeader, csrfToken, publicationId,
      blocks,
      { title: content.title, snippet, imageId: coverImageId },
      options.draft
    );

    const articleUrl = `${BASE_URL}/a/${publicationId}`;
    console.log(`\n✅ ${options.draft ? 'Draft saved' : 'Published'}: ${articleUrl}`);

    return { success: true, url: articleUrl };
  } catch (error: any) {
    console.error('❌ Dzen API publish error:', error.message);
    return { success: false, error: error.message };
  }
}
