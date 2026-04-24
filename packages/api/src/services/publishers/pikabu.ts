/**
 * Pikabu (pikabu.ru) Publisher — internal AJAX API + binary WebSocket image upload.
 *
 * No public API exists; this mimics the web editor's network calls directly.
 *
 * Flow:
 *   1. Load cookies from pikabu-state.json (uploaded via Settings UI)
 *   2. GET  /add                                   → parse CSRF token from HTML
 *   3. POST /ajax.php route=story-draft/save       → create empty draft, get draft_id
 *   4. Upload images via wss://ws.pikabu.ru/ binary protocol (see pikabu-ws-upload)
 *   5. POST /ajax.php route=story-draft/save id=.. → update draft with full blocks
 *   6. POST /ajax/gtpost_actions.php action=publish → final publish
 *   7. Extract story_id from response → build story URL
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { ArticleContent, CoverImage } from '@content-pipeline/shared';
import { uploadImagesToPikabu } from './pikabu-ws-upload';

// ── Types ──────────────────────────────────────────────────────────────────────

type ArticleWithCover = {
  id: string;
  celebrityName: string;
  content: ArticleContent | any;
  coverImages?: CoverImage[];
  coverImage?: CoverImage;
  tags?: string[] | string;
  [key: string]: any;
};

export interface PikabuPublishResult {
  success: boolean;
  url?: string;
  storyId?: number;
  error?: string;
}

interface PikabuBlock {
  id: string;
  type: 'text' | 'image';
  body?: string;
  title?: string;
  url?: string;
  size?: [number, number];
}

// ── Config ─────────────────────────────────────────────────────────────────────

const SESSIONS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'pikabu-sessions')
  : path.resolve(__dirname, './sessions');
const PIKABU_STATE_FILE = path.join(SESSIONS_DIR, 'pikabu-state.json');

const BASE_URL = 'https://pikabu.ru';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// Default tags for Russian celebrity-bio content (Pikabu requires ≥2)
const DEFAULT_TAGS = ['Истории', 'Биография'];

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolveImagePath(imagePath: string): string {
  const storageBase = process.env.STORAGE_PATH || process.cwd();
  if (imagePath.startsWith('/images/')) return path.join(storageBase, imagePath);
  if (imagePath.startsWith('/covers/')) return path.join(storageBase, imagePath);
  return imagePath;
}

/** Load cookies JSON → returns cookie header string for pikabu.ru */
function loadCookies(): string {
  if (!fs.existsSync(PIKABU_STATE_FILE)) {
    throw new Error('No Pikabu session found. Upload cookies via Settings page first.');
  }
  const session = JSON.parse(fs.readFileSync(PIKABU_STATE_FILE, 'utf-8'));
  const cookies: any[] = session.cookies || [];
  const pikabuCookies = cookies.filter(
    (c) => c?.name && c?.value && (c.domain?.includes('pikabu.ru') || !c.domain)
  );
  if (pikabuCookies.length === 0) {
    throw new Error('Pikabu session has no pikabu.ru cookies');
  }
  return pikabuCookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function baseHeaders(cookieHeader: string, csrfToken?: string, referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cookie': cookieHeader,
    'Origin': BASE_URL,
    'Referer': referer || `${BASE_URL}/add`,
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  };
  if (csrfToken) h['X-Csrf-Token'] = csrfToken;
  return h;
}

/** GET /add and extract CSRF token from the HTML */
async function getCsrfToken(cookieHeader: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/add`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'Cookie': cookieHeader,
      'User-Agent': USER_AGENT,
    },
    redirect: 'manual',
  });
  if (res.status === 302 || res.status === 301) {
    throw new Error(
      `Pikabu /add redirected to ${res.headers.get('location')} — session likely expired, re-upload cookies.`
    );
  }
  if (!res.ok) {
    throw new Error(`GET /add failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  // The token is embedded in JS as: window.App.setCsrfToken("...") or data-csrf-token="..."
  const patterns = [
    /csrfToken["':\s]+([a-f0-9]{32})/i,
    /csrf[-_]?token["'=:\s]+([a-f0-9]{32})/i,
    /data-csrf-token=["']([a-f0-9]{32})["']/i,
    /"csrf[^"]*"\s*:\s*"([a-f0-9]{32})"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  throw new Error('Could not find CSRF token in /add HTML');
}

/** Generate a unique block id (12-digit like Pikabu does). */
function genBlockId(counter: number): string {
  // Pikabu uses `${unix_ts}${two_digit_seq}` — 12 digits total.
  const ts = Math.floor(Date.now() / 1000);
  const seq = String(counter % 100).padStart(2, '0');
  return `${ts}${seq}`;
}

// ── Draft save / publish ──────────────────────────────────────────────────────

function buildBaseDataObject(
  title: string,
  blocks: PikabuBlock[],
  tagsStr: string
): Record<string, any> {
  return {
    title,
    blocks,
    tags: tagsStr,
    is_story_boost: false,
    is_author_content: false,
    is_authors: false,
    is_adult: false,
    is_anonymous_story: false,
    is_donations_disabled: false,
    is_comments_disabled: false,
    is_advert_blogs: false,
    advert_company: '',
    scheduled_time: null,
    story_id: 0,
    parent_story_id: 0,
    color_theme: 0,
    is_community: false,
    is_not_advert: false,
    schedule_id: 0,
    advert_seo_title: '',
    advert_seo_description: '',
    time: Math.floor(Date.now() / 1000),
  };
}

/** POST /ajax.php route=story-draft/save — creates (no id) or updates (with id) draft. */
async function saveDraft(
  cookieHeader: string,
  csrfToken: string,
  data: Record<string, any>,
  draftId?: number
): Promise<{ id: number }> {
  const params = new URLSearchParams();
  params.set('route', 'story-draft/save');
  params.set('data', JSON.stringify(data));
  params.set('parent_story_id', '0');
  if (draftId) params.set('id', String(draftId));

  const res = await fetch(`${BASE_URL}/ajax.php`, {
    method: 'POST',
    headers: {
      ...baseHeaders(cookieHeader, csrfToken),
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: params.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`story-draft/save failed: ${res.status} ${text.slice(0, 300)}`);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`story-draft/save returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (json.result === false) {
    throw new Error(`story-draft/save error: ${json.message || JSON.stringify(json).slice(0, 200)}`);
  }
  const id = json.data?.id ?? json.data?.draft_id ?? draftId;
  if (!id && !draftId) {
    throw new Error(`story-draft/save response missing id: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { id: Number(id ?? draftId) };
}

/** POST /ajax/gtpost_actions.php action=publish — final publish. */
async function finalPublish(
  cookieHeader: string,
  csrfToken: string,
  data: Record<string, any>,
  draftId: number
): Promise<{ storyId: number; url: string }> {
  const params = new URLSearchParams();
  params.set('action', 'publish');
  params.set('time', String(Math.floor(Date.now() / 1000)));
  params.set('data', JSON.stringify(data));
  params.set('story_id', '0');
  params.set('parent_story_id', '0');
  params.set('draft_id', String(draftId));

  const res = await fetch(`${BASE_URL}/ajax/gtpost_actions.php`, {
    method: 'POST',
    headers: {
      ...baseHeaders(cookieHeader, csrfToken),
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`gtpost_actions.php publish failed: ${res.status} ${text.slice(0, 300)}`);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`publish returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (json.result === false) {
    throw new Error(`publish error: ${json.message || JSON.stringify(json).slice(0, 300)}`);
  }

  // Response shape varies; try a few shapes.
  const d = json.data || {};
  const storyId = Number(d.story_id || d.id || d.storyId || 0);
  let url: string | undefined = d.url || d.story_url;
  if (!url && storyId) {
    // Pikabu URLs look like /story/<slug>_<id>. Since we don't have slug in API
    // response, fall back to /story/_<id> which redirects correctly.
    url = `${BASE_URL}/story/_${storyId}`;
  }
  if (!url) {
    throw new Error(`publish response missing URL/storyId: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return { storyId, url };
}

// ── Image fetching ────────────────────────────────────────────────────────────

async function loadImageBytes(src: string): Promise<Buffer> {
  if (src.startsWith('http://') || src.startsWith('https://')) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`Failed to download image: ${r.status} ${src.slice(0, 100)}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const p = resolveImagePath(src);
  if (!fs.existsSync(p)) throw new Error(`Image file not found: ${p}`);
  return fs.readFileSync(p);
}

async function getImageSize(buf: Buffer): Promise<[number, number]> {
  try {
    const meta = await sharp(buf).metadata();
    return [meta.width || 800, meta.height || 600];
  } catch {
    return [800, 600];
  }
}

// ── HTML text builders ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
}

function heading(text: string, level: 3 | 4 = 3): string {
  return `<h${level}>${escapeHtml(text)}</h${level}>`;
}

function blockquoteHtml(text: string): string {
  return `<blockquote>${escapeHtml(text)}</blockquote>`;
}

// ── Main publisher ────────────────────────────────────────────────────────────

function resolveTags(article: ArticleWithCover, content: ArticleContent): string {
  // Priority: explicit article.tags → derive from celebrity name → defaults
  let tags: string[] = [];
  if (Array.isArray(article.tags)) tags = article.tags.filter(Boolean);
  else if (typeof article.tags === 'string' && article.tags.trim()) {
    tags = article.tags.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (tags.length === 0 && article.celebrityName) {
    tags = [article.celebrityName, 'Истории'];
  }
  if (tags.length < 2) {
    for (const def of DEFAULT_TAGS) {
      if (!tags.includes(def)) tags.push(def);
      if (tags.length >= 2) break;
    }
  }
  // Pikabu has a max-length / max-count; keep at most 5 short tags
  return tags.slice(0, 5).join(',');
}

export async function publishToPikabu(article: ArticleWithCover): Promise<PikabuPublishResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📰 Publishing to Pikabu: "${article.celebrityName}"`);
  console.log(`${'='.repeat(60)}\n`);

  const content = article.content as ArticleContent | null;
  if (!content) return { success: false, error: 'Article has no content' };

  try {
    // 1. Auth
    const cookieHeader = loadCookies();
    console.log('🔑 Getting CSRF token from /add...');
    const csrfToken = await getCsrfToken(cookieHeader);
    console.log(`   ✅ CSRF: ${csrfToken.slice(0, 8)}...`);

    // 2. Create empty draft
    const tagsStr = resolveTags(article, content);
    const title = content.title || article.celebrityName;
    const initialData = buildBaseDataObject(title, [], tagsStr);

    console.log('📄 Creating empty Pikabu draft...');
    const { id: draftId } = await saveDraft(cookieHeader, csrfToken, initialData);
    console.log(`   ✅ Draft: ${draftId}`);

    // 3. Collect images to upload (cover + per-section)
    const coverImage =
      article.coverImages?.find((c) => c.isSelected) ||
      article.coverImages?.[0] ||
      article.coverImage;

    type ImageSlot = {
      label: string;
      src: string;
      // Populated after upload:
      url?: string;
      size?: [number, number];
    };
    const slots: ImageSlot[] = [];

    if (coverImage) {
      const src =
        coverImage.localPath || coverImage.processedImageUrl || coverImage.originalImageUrl;
      if (src) slots.push({ label: 'cover', src });
    }
    for (const s of content.sections || []) {
      if (s.imageUrl) slots.push({ label: `section-${s.number}`, src: s.imageUrl });
    }

    // 4. Fetch bytes + sizes, then upload via WS
    console.log(`🖼️  Loading ${slots.length} image(s)...`);
    const buffers: Buffer[] = [];
    const sizes: [number, number][] = [];
    for (const slot of slots) {
      try {
        const buf = await loadImageBytes(slot.src);
        const size = await getImageSize(buf);
        buffers.push(buf);
        sizes.push(size);
        console.log(
          `   📦 ${slot.label}: ${(buf.length / 1024).toFixed(1)}KB ${size[0]}x${size[1]}`
        );
      } catch (err: any) {
        console.error(`   ⚠️ ${slot.label} load failed: ${err.message}`);
        buffers.push(Buffer.alloc(0));
        sizes.push([0, 0]);
      }
    }

    const validIndexes = buffers
      .map((b, i) => (b.length > 0 ? i : -1))
      .filter((i) => i >= 0);

    if (validIndexes.length > 0) {
      console.log(`📤 Uploading ${validIndexes.length} image(s) via WS...`);
      const uploadResults = await uploadImagesToPikabu(
        cookieHeader,
        csrfToken,
        validIndexes.map((i) => buffers[i])
      );
      uploadResults.forEach((r, k) => {
        const slotIdx = validIndexes[k];
        slots[slotIdx].url = r.tmp_file_url;
        slots[slotIdx].size = sizes[slotIdx];
        console.log(`   ✅ ${slots[slotIdx].label}: ${r.tmp_file_url}`);
      });
    }

    // 5. Build blocks in article order
    const blocks: PikabuBlock[] = [];
    let blockCounter = 0;
    const makeId = () => genBlockId(blockCounter++);

    // Teaser
    if (content.teaser) {
      blocks.push({ id: makeId(), type: 'text', body: paragraph(content.teaser) });
    }

    // Cover image
    const coverSlot = slots.find((s) => s.label === 'cover');
    if (coverSlot?.url) {
      blocks.push({
        id: makeId(),
        type: 'image',
        title: '',
        url: coverSlot.url,
        size: coverSlot.size || [800, 600],
      });
    }

    // Sections
    for (const section of content.sections || []) {
      blocks.push({
        id: makeId(),
        type: 'text',
        body: heading(`${section.number}. ${section.heading}`),
      });

      const sectionSlot = slots.find((s) => s.label === `section-${section.number}`);
      if (sectionSlot?.url) {
        blocks.push({
          id: makeId(),
          type: 'image',
          title: '',
          url: sectionSlot.url,
          size: sectionSlot.size || [800, 600],
        });
      }

      if (section.paragraph1) {
        blocks.push({ id: makeId(), type: 'text', body: paragraph(section.paragraph1) });
      }
      if (section.paragraph2) {
        blocks.push({ id: makeId(), type: 'text', body: paragraph(section.paragraph2) });
      }
      if (section.blockquote) {
        blocks.push({ id: makeId(), type: 'text', body: blockquoteHtml(section.blockquote) });
      }
    }

    // Conclusion
    if (content.conclusion) {
      blocks.push({ id: makeId(), type: 'text', body: heading(content.conclusion.heading) });
      blocks.push({ id: makeId(), type: 'text', body: paragraph(content.conclusion.text) });
    }

    // Hero quote
    if (content.heroQuote) {
      blocks.push({
        id: makeId(),
        type: 'text',
        body: blockquoteHtml(`«${content.heroQuote.text}» — ${content.heroQuote.author}`),
      });
    }

    // Bonus fact
    if (content.bonusFact) {
      blocks.push({ id: makeId(), type: 'text', body: heading('🎁 Бонусный факт:') });
      blocks.push({ id: makeId(), type: 'text', body: paragraph(content.bonusFact) });
    }

    if (content.cta) {
      blocks.push({ id: makeId(), type: 'text', body: paragraph(content.cta) });
    }
    if (content.brandEnding) {
      blocks.push({ id: makeId(), type: 'text', body: paragraph(content.brandEnding) });
    }

    console.log(`📊 Built ${blocks.length} blocks (${blocks.filter((b) => b.type === 'image').length} images)`);

    // 6. Save full draft
    const fullData = buildBaseDataObject(title, blocks, tagsStr);
    console.log('💾 Saving full draft...');
    await saveDraft(cookieHeader, csrfToken, fullData, draftId);

    // 7. Publish
    console.log('🚀 Publishing...');
    const { storyId, url } = await finalPublish(cookieHeader, csrfToken, fullData, draftId);
    console.log(`\n✅ Published: ${url} (story_id=${storyId})`);

    return { success: true, url, storyId };
  } catch (error: any) {
    console.error('❌ Pikabu publish error:', error.message);
    return { success: false, error: error.message };
  }
}
