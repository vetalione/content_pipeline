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
import { chromium } from 'playwright';
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

// ── CSRF Hash via Playwright ───────────────────────────────────────────────────

/**
 * Build Playwright cookie list from vk-state.json.
 * Also checks for expired cookies and warns.
 */
function buildPlaywrightCookies(): any[] {
  if (!fs.existsSync(VK_STATE_FILE)) {
    throw new Error('No VK session found. Upload cookies via Settings page first.');
  }
  const session = JSON.parse(fs.readFileSync(VK_STATE_FILE, 'utf-8'));
  const rawCookies: any[] = session.cookies || [];

  const vkCookies = rawCookies
    .filter((c: any) => c.domain && (c.domain.includes('vk.com') || c.domain.includes('.vk.com')));

  console.log(`   🍪 VK cookies in file: ${vkCookies.length} (total: ${rawCookies.length})`);

  const now = Math.floor(Date.now() / 1000);
  const keyNames = ['remixsid', 'remixnsid', 'remixlhk', 'remixlang', 'remixdt', 'remixua'];

  const cookies = vkCookies.map((c: any) => {
    const rawSS = (c.sameSite || '').toString().toLowerCase();
    // "no_restriction" in EditThisCookie = browser default = Lax.
    // "None" in stored file (from our broken conversion) = also force to Lax.
    const sameSite: 'Strict' | 'Lax' | 'None' = rawSS === 'strict' ? 'Strict' : 'Lax';

    const expires = c.expires ?? c.expirationDate ?? -1;

    // Check for expired cookies
    if (expires > 0 && expires < now && keyNames.includes(c.name)) {
      console.log(`   ⚠️ EXPIRED cookie: ${c.name} (expired ${new Date(expires * 1000).toISOString()})`);
    }

    return {
      name: c.name,
      value: c.value,
      domain: c.domain || '.vk.com',
      path: c.path || '/',
      expires,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite,
    };
  });

  // Log key cookies for debugging
  for (const name of keyNames) {
    const c = cookies.find((ck: any) => ck.name === name);
    if (c) {
      const expStr = c.expires > 0
        ? (c.expires < now ? `EXPIRED ${new Date(c.expires * 1000).toISOString()}` : `valid until ${new Date(c.expires * 1000).toISOString()}`)
        : 'session';
      console.log(`   🍪 ${c.name}: domain=${c.domain} secure=${c.secure} ss=${c.sameSite} exp=${expStr}`);
    }
  }

  const expired = cookies.filter((c: any) => c.expires > 0 && c.expires < now);
  if (expired.length > 0) {
    console.log(`   ⚠️ ${expired.length}/${cookies.length} cookies are expired! Re-upload fresh cookies.`);
  }

  return cookies;
}

/** Try to extract editor hash from VK's al_articles.php response payload */
function extractHashFromPayload(body: string): { hash: string | null; code: string | number | null; rawPayload: string } {
  try {
    const json = JSON.parse(body);
    const payload = json?.payload;
    if (!Array.isArray(payload) || payload.length < 2) {
      return { hash: null, code: null, rawPayload: body.substring(0, 300) };
    }
    const code = payload[0];
    if (code === '3' || code === 3) {
      // Access-check gate — payload[1] has [hash, redirect_url, token]
      return { hash: null, code, rawPayload: JSON.stringify(payload[1]).substring(0, 300) };
    }
    const str = JSON.stringify(payload[1]);
    const hashMatch = str.match(/"hash"\s*:\s*"([a-f0-9]{14,22})"/);
    return { hash: hashMatch?.[1] || null, code, rawPayload: str.substring(0, 300) };
  } catch {
    return { hash: null, code: null, rawPayload: body.substring(0, 300) };
  }
}

/**
 * Extract the VK articles editor CSRF hash using Playwright.
 *
 * Phase 1: CDP cookies → navigate to blank.php (completes login verification chain)
 * Phase 2: In-page AJAX from blank.php (best case — hash returned directly)
 * Phase 3: Navigate to editor URL → handle challenge.html → retry AJAX
 *
 * VK's code 3 for al_articles.php is resolved by passing challenge.html,
 * NOT by the login.vk.com redirect chain (that only resolves page access).
 */
async function fetchEditorHash(cookieHeader: string): Promise<{ hash: string; cookies: string }> {
  const groupId = getGroupId();
  const screenName = await getGroupScreenName();

  console.log(`   🎭 Launching Playwright to get VK editor hash...`);

  const pwCookies = buildPlaywrightCookies();
  console.log(`   🍪 Prepared ${pwCookies.length} cookies for Playwright`);

  const screenshotsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'vk-screenshots')
    : '/tmp/vk-screenshots';
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: USER_AGENT,
    });

    const page = await context.newPage();

    // ── Inject cookies via CDP (most reliable method) ──
    const client = await context.newCDPSession(page);
    let cdpOk = 0;
    for (const c of pwCookies) {
      try {
        await client.send('Network.setCookie', {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expires: c.expires > 0 ? c.expires : undefined,
        });
        cdpOk++;
      } catch {}
    }
    console.log(`   🍪 CDP: ${cdpOk}/${pwCookies.length} cookies set`);

    // Track redirects
    page.on('request', (request) => {
      if (request.isNavigationRequest()) {
        const prev = request.redirectedFrom();
        if (prev) {
          console.log(`   🔄 ${prev.url().substring(0, 100)} → ${request.url().substring(0, 100)}`);
        }
      }
    });

    let capturedHash: string | null = null;

    // Intercept al_articles.php responses globally for hash capture
    page.on('response', async (response) => {
      if (!response.url().includes('al_articles.php')) return;
      try {
        const body = await response.text();
        const parsed = extractHashFromPayload(body);
        if (parsed.hash && !capturedHash) {
          capturedHash = parsed.hash;
          console.log(`   🔑 Hash from network intercept: ${capturedHash}`);
        }
      } catch {}
    });

    // ── Phase 1: Navigate to blank.php to establish verified session ──
    console.log(`\n   ── Phase 1: Establish session via blank.php ──`);
    try {
      await page.goto('https://vk.com/blank.php', {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      const url = page.url();
      console.log(`   📄 Landed: ${url}`);

      if (url.includes('login.vk.com') || !url.includes('vk.com')) {
        throw new Error(`Session not established — landed on: ${url}`);
      }
    } catch (err: any) {
      console.log(`   ⚠️ blank.php: ${err.message?.substring(0, 150)}`);
      throw new Error('Could not establish VK session. Cookies may be expired.');
    }

    // ── Phase 2: In-page AJAX from blank.php ──
    console.log(`\n   ── Phase 2: In-page AJAX from blank.php ──`);

    const ajaxCall = async (): Promise<{ status: number; body: string } | { error: string }> => {
      return page.evaluate(async (gid) => {
        try {
          const body = new URLSearchParams({
            act: 'edit',
            al: '1',
            article_id: '0',
            article_owner_id: `-${gid}`,
          });
          const res = await fetch('/al_articles.php', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body,
            credentials: 'include',
          });
          return { status: res.status, body: await res.text() };
        } catch (e: any) {
          return { error: e.message };
        }
      }, groupId);
    };

    const ajaxResult = await ajaxCall();

    if ('error' in ajaxResult) {
      console.log(`   ⚠️ AJAX error: ${ajaxResult.error}`);
    } else {
      console.log(`   📡 AJAX: status=${ajaxResult.status}, ${ajaxResult.body.length} bytes`);
      const parsed = extractHashFromPayload(ajaxResult.body);
      console.log(`   📋 code=${parsed.code}, hash=${parsed.hash || 'N/A'}`);
      if (!parsed.hash) console.log(`   📋 payload: ${parsed.rawPayload}`);
      if (parsed.hash) {
        capturedHash = parsed.hash;
        console.log(`   ✅ Hash via in-page AJAX: ${capturedHash}`);
      }
    }

    // ── Phase 3: Navigate to editor → handle challenge → retry AJAX ──
    // VK's code 3 for al_articles.php is ONLY resolved by passing challenge.html.
    // The editor page loads, then VK's JS sees code 3 and redirects to challenge.
    if (!capturedHash) {
      console.log(`\n   ── Phase 3: Navigate to editor + handle challenge ──`);

      const editorUrl = `https://vk.com/${screenName}?z=article_edit-${groupId}_0`;
      console.log(`   📄 Opening editor: ${editorUrl}`);

      try {
        await page.goto(editorUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 25_000,
        });
        console.log(`   📄 Initial URL: ${page.url()}`);

        // Wait for URL to settle — challenge.html redirect is CLIENT-SIDE JS,
        // so it happens AFTER domcontentloaded. Poll until URL stabilizes.
        let lastUrl = page.url();
        for (let i = 0; i < 10; i++) {
          await sleep(1000);
          const currentUrl = page.url();
          if (capturedHash) break; // Hash captured via network intercept
          if (currentUrl !== lastUrl) {
            console.log(`   📄 URL changed: ${currentUrl.substring(0, 120)}`);
            lastUrl = currentUrl;
          } else if (i >= 2) {
            // URL stable for 2+ seconds
            break;
          }
        }

        console.log(`   📄 Final URL: ${page.url()}`);
      } catch (err: any) {
        console.log(`   ⚠️ Editor nav: ${err.message?.substring(0, 150)}`);
      }

      // Check if hash was captured during editor load
      if (capturedHash) {
        console.log(`   ✅ Hash captured during editor navigation!`);
      }

      // Handle challenge page
      if (!capturedHash && page.url().includes('challenge.html')) {
        console.log(`\n   ── Challenge page detected! ──`);

        // Take screenshot for diagnostics
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const screenshotPath = path.join(screenshotsDir, `vk-challenge_${timestamp}.png`);
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          console.log(`   📸 Screenshot saved: ${screenshotPath}`);
        } catch {}

        // Read the page content for analysis
        const pageInfo = await page.evaluate(() => {
          const title = document.title;
          const bodyText = document.body?.innerText?.substring(0, 1000) || '';
          const forms = Array.from(document.querySelectorAll('form')).map(f => ({
            action: f.action,
            method: f.method,
            inputs: Array.from(f.querySelectorAll('input')).map(i => ({
              type: i.type, name: i.name, placeholder: i.placeholder, value: i.value
            }))
          }));
          const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a.flat_button, .FlatButton')).map(b => ({
            tag: b.tagName,
            text: (b as HTMLElement).innerText?.trim() || '',
            id: b.id,
            className: b.className
          }));
          const iframes = Array.from(document.querySelectorAll('iframe')).map(f => f.src);
          return { title, bodyText, forms, buttons, iframes };
        });

        console.log(`   📄 Title: "${pageInfo.title}"`);
        console.log(`   📄 Body text: ${pageInfo.bodyText.substring(0, 300)}`);
        console.log(`   📄 Forms: ${JSON.stringify(pageInfo.forms).substring(0, 500)}`);
        console.log(`   📄 Buttons: ${JSON.stringify(pageInfo.buttons).substring(0, 500)}`);
        if (pageInfo.iframes.length > 0) console.log(`   📄 Iframes: ${pageInfo.iframes.join(', ')}`);

        // Try to auto-handle common challenge types:
        // 1. Simple "confirm" / "this is me" button
        let challengeResolved = false;
        for (const btn of pageInfo.buttons) {
          const text = btn.text.toLowerCase();
          if (text.match(/confirm|this is me|continue|proceed|подтвердить|это я|продолжить|да|отправить|send|submit/)) {
            console.log(`   🔘 Clicking: "${btn.text}" (${btn.tag})`);
            try {
              const selector = btn.id
                ? `#${btn.id}`
                : btn.tag === 'BUTTON'
                  ? `button:has-text("${btn.text}")`
                  : `input[type="submit"]`;
              await page.click(selector, { timeout: 5_000 });
              console.log(`   ✅ Clicked!`);

              // Wait for navigation
              await sleep(3000);
              const postClickUrl = page.url();
              console.log(`   📄 After click: ${postClickUrl}`);

              if (!postClickUrl.includes('challenge.html')) {
                challengeResolved = true;
                console.log(`   ✅ Challenge resolved!`);
              }
            } catch (e: any) {
              console.log(`   ⚠️ Click failed: ${e.message?.substring(0, 100)}`);
            }
            break;
          }
        }

        // 2. If challenge has a form with phone/code input — log it for the user
        if (!challengeResolved) {
          for (const form of pageInfo.forms) {
            for (const input of form.inputs) {
              if (input.type === 'tel' || input.type === 'text' || input.name?.includes('code') || input.name?.includes('phone')) {
                console.log(`   ⚠️ Challenge requires input: type=${input.type}, name=${input.name}, placeholder="${input.placeholder}"`);
                console.log(`   ❌ Cannot auto-resolve: VK wants phone/code verification.`);
                console.log(`   💡 Open vk.com in a browser on the same IP, resolve the challenge, then re-try.`);
              }
            }
          }
        }

        // After challenge resolution, retry AJAX
        if (challengeResolved) {
          // Navigate back to blank.php for a clean AJAX context
          try {
            await page.goto('https://vk.com/blank.php', {
              waitUntil: 'domcontentloaded',
              timeout: 15_000,
            });
          } catch {}

          if (page.url().includes('vk.com') && !page.url().includes('challenge') && !page.url().includes('login')) {
            console.log(`   📡 Retrying AJAX after challenge...`);
            await sleep(1000);
            const retryResult = await ajaxCall();
            if (!('error' in retryResult)) {
              const parsed = extractHashFromPayload(retryResult.body);
              console.log(`   📋 Post-challenge: code=${parsed.code}, hash=${parsed.hash || 'N/A'}`);
              if (parsed.hash) {
                capturedHash = parsed.hash;
                console.log(`   ✅ Hash after challenge: ${capturedHash}`);
              }
            }
          }
        }

        // Wait for hash from network intercept (editor may have loaded in background)
        if (!capturedHash) {
          for (let i = 0; i < 10 && !capturedHash; i++) {
            await sleep(500);
          }
        }
      }
    }

    // Capture final cookies from browser jar
    const browserCookies = await context.cookies('https://vk.com');
    const cookieString = browserCookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`   🍪 Final: ${browserCookies.length} cookies`);

    await page.close();

    if (!capturedHash) {
      throw new Error(
        'Could not extract VK editor hash. Likely VK challenge page requires human interaction. ' +
        'Check screenshots in vk-screenshots/. Try: open vk.com on the same server IP to resolve the challenge.'
      );
    }

    console.log(`   ✅ VK editor hash obtained: ${capturedHash}`);
    return { hash: capturedHash, cookies: cookieString || cookieHeader };
  } finally {
    await browser.close();
    console.log(`   🎭 Browser closed`);
  }
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

    // Upload as wall photo (photos.getArticleUploadServer is VK-internal only)
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
  const uuid = crypto.randomUUID();
  const slug = generateSlug(title);

  console.log(`📰 VK Article: "${title}"`);
  console.log('============================================================');

  // 1. Load cookies
  const cookieHeader = loadVkCookies();
  console.log('🍪 VK cookies loaded');

  // 2. Get CSRF hash from editor page (also captures any session cookies from access check)
  console.log('🔑 Getting editor hash...');
  const { hash, cookies: sessionCookies } = await fetchEditorHash(cookieHeader);
  // Use the session cookies (with any access-check cookies merged) for all subsequent requests
  const activeCookieHeader = sessionCookies;

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
