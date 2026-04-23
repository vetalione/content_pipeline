/**
 * VK Publisher — Group wall post with cover photo and article text
 *
 * Flow:
 * 1. Upload cover photo to VK via photos API
 * 2. Build formatted wall post text from article content
 * 3. Post to VK group wall: cover photo + formatted text
 *
 * Note: VK Articles (vk.com/@group) will be added later via HTTP API
 * for full rich-text articles. For now, wall posts support up to ~16K chars.
 *
 * Env vars:
 *   VK_ACCESS_TOKEN  — group or user token with wall.post + photos permissions
 *   VK_GROUP_ID      — numeric group ID (without minus sign)
 */

import fs from 'fs';
import { ArticleContent, CoverImage } from '@content-pipeline/shared';
import {
  ArticleWithCover,
  resolveImagePath,
} from './telegram';
import { publishVkArticle, isVkSessionAvailable } from './vk-articles';

// ── Config ─────────────────────────────────────────────────────────────────────

const VK_API = 'https://api.vk.com/method';
const VK_API_VERSION = '5.199';

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

// ── VK API Helpers ─────────────────────────────────────────────────────────────

async function vkApi(method: string, params: Record<string, string>): Promise<any> {
  const token = getAccessToken();
  const body = new URLSearchParams({
    ...params,
    access_token: token,
    v: VK_API_VERSION,
  });

  const res = await fetch(`${VK_API}/${method}`, {
    method: 'POST',
    body,
  });

  const data = await res.json() as any;
  if (data.error) {
    throw new Error(`VK API ${method}: [${data.error.error_code}] ${data.error.error_msg}`);
  }
  return data.response;
}

// ── Photo Upload ───────────────────────────────────────────────────────────────

/**
 * Upload a photo to VK for use in a wall post.
 * Steps: getWallUploadServer → upload file → saveWallPhoto
 * Returns attachment string like "photo-12345_67890"
 */
async function uploadPhotoToVK(imagePath: string): Promise<string | null> {
  const groupId = getGroupId();

  // 1. Resolve image path
  let resolved: string;
  let isTempFile = false;
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    // Download remote image to temp
    try {
      const res = await fetch(imagePath, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        console.error(`   ⚠️ VK: failed to download image: ${res.status}`);
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const tmpPath = `/tmp/vk-upload-${Date.now()}.jpg`;
      fs.writeFileSync(tmpPath, buffer);
      resolved = tmpPath;
      isTempFile = true;
    } catch (err: any) {
      console.error(`   ⚠️ VK: image download error: ${err.message}`);
      return null;
    }
  } else {
    resolved = resolveImagePath(imagePath);
  }

  if (!fs.existsSync(resolved)) {
    console.error(`   ⚠️ VK: image not found: ${resolved}`);
    return null;
  }

  try {
    // 2. Get upload URL
    const uploadServer = await vkApi('photos.getWallUploadServer', {
      group_id: groupId,
    });
    const uploadUrl = uploadServer.upload_url;
    console.log(`   📤 VK: got upload server`);

    // 3. Upload file via multipart
    const imageBuffer = fs.readFileSync(resolved);
    const ext = resolved.toLowerCase().endsWith('.png') ? '.png' : '.jpg';
    const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

    const boundary = '----VKUpload' + Math.random().toString(36).substring(2);
    const parts: Buffer[] = [];
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="cover${ext}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    ));
    parts.push(imageBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const uploadData = await uploadRes.json() as any;

    if (!uploadData.photo || uploadData.photo === '[]') {
      console.error('   ⚠️ VK: photo upload returned empty result');
      return null;
    }
    console.log(`   📤 VK: file uploaded to server`);

    // 4. Save wall photo
    const saved = await vkApi('photos.saveWallPhoto', {
      group_id: groupId,
      server: String(uploadData.server),
      photo: uploadData.photo,
      hash: uploadData.hash,
    });

    if (!saved || saved.length === 0) {
      console.error('   ⚠️ VK: saveWallPhoto returned empty');
      return null;
    }

    const photo = saved[0];
    const attachment = `photo${photo.owner_id}_${photo.id}`;
    console.log(`   ✅ VK: photo saved: ${attachment}`);
    return attachment;
  } catch (err: any) {
    console.error(`   ⚠️ VK: photo upload error: ${err.message}`);
    return null;
  } finally {
    // Clean up temp file
    if (isTempFile) {
      try { fs.unlinkSync(resolved); } catch { /* ignore */ }
    }
  }
}

// ── Wall Post ──────────────────────────────────────────────────────────────────

async function createWallPost(
  message: string,
  attachments: string[]
): Promise<string> {
  const groupId = getGroupId();

  const params: Record<string, string> = {
    owner_id: `-${groupId}`,
    from_group: '1',
    message,
  };

  if (attachments.length > 0) {
    // VK allows up to 10 attachments per post, comma-separated
    params.attachments = attachments.slice(0, 10).join(',');
  }

  const result = await vkApi('wall.post', params);
  const postId = result.post_id;
  const url = `https://vk.com/wall-${groupId}_${postId}`;
  return url;
}

// ── Text Builder ───────────────────────────────────────────────────────────────

/** Build a formatted wall post from article content. VK supports ~16K chars. */
function buildWallText(title: string, content: ArticleContent): string {
  const parts: string[] = [];

  // Title — emphasized with emoji + uppercase
  parts.push(`📰 ${title.toUpperCase()}`);
  parts.push('');
  parts.push('━━━━━━━━━━━━━━━━━━━━');
  parts.push('');

  // Teaser
  if (content.teaser) {
    parts.push(content.teaser);
    parts.push('');
  }

  // Sections
  for (let i = 0; i < content.sections.length; i++) {
    const section = content.sections[i];
    const num = i + 1;
    parts.push('');
    parts.push(`▌ ${num}. ${section.heading.toUpperCase()}`);
    parts.push('');
    if (section.paragraph1) parts.push(section.paragraph1);
    if (section.paragraph2) {
      parts.push('');
      parts.push(section.paragraph2);
    }
    if (section.blockquote) {
      parts.push('');
      parts.push(`💬 «${section.blockquote}»`);
    }
    parts.push('');
  }

  // Conclusion
  if (content.conclusion) {
    parts.push('━━━━━━━━━━━━━━━━━━━━');
    parts.push('');
    parts.push(`✨ ${content.conclusion.heading.toUpperCase()}`);
    parts.push('');
    parts.push(content.conclusion.text);
    parts.push('');
  }

  // Hero quote
  if (content.heroQuote) {
    parts.push('');
    parts.push(`💭 «${content.heroQuote.text}»`);
    parts.push(`    — ${content.heroQuote.author}`);
    parts.push('');
  }

  // Bonus fact
  if (content.bonusFact) {
    parts.push('');
    parts.push('🎁 БОНУСНЫЙ ФАКТ:');
    parts.push(content.bonusFact);
    parts.push('');
  }

  // CTA
  if (content.cta) {
    parts.push('━━━━━━━━━━━━━━━━━━━━');
    parts.push('');
    parts.push(content.cta);
  }

  // Brand ending
  if (content.brandEnding) {
    parts.push('');
    parts.push(content.brandEnding);
  }

  // VK wall.post limit is ~16,384 chars
  const text = parts.join('\n');
  if (text.length > 16000) {
    return text.substring(0, 15997) + '...';
  }
  return text;
}

/** Short wall post with link to the full VK Article */
function buildWallTextWithLink(title: string, content: ArticleContent, articleUrl: string): string {
  const parts: string[] = [];
  parts.push(`📰 ${title}`);
  parts.push('');
  if (content.teaser) {
    parts.push(content.teaser);
    parts.push('');
  }
  parts.push(`👉 Читать полностью: ${articleUrl}`);
  return parts.join('\n');
}

// ── Main Entry Point ───────────────────────────────────────────────────────────

/**
 * Publish article to VK:
 * 1. Try VK Article via cookies (optional — falls back on failure)
 * 2. Upload cover + section images (up to 10 total)
 * 3. Post to group wall with full formatted text + all images as carousel
 */
export async function publishToVK(article: ArticleWithCover): Promise<{ url: string }> {
  const content = article.content as ArticleContent;
  if (!content) throw new Error('Article has no content');

  const title = content.title || article.celebrityName;
  const coverImage = article.coverImages?.find((c: CoverImage) => c.isSelected)
    || article.coverImages?.[0];

  console.log(`📰 Publishing to VK: "${title}"`);
  console.log('============================================================');

  // 1. Try to create VK Article (requires cookies from Settings; may fail due to IP binding)
  let articleUrl: string | undefined;
  if (isVkSessionAvailable()) {
    try {
      console.log('📝 Creating VK Article...');
      const result = await publishVkArticle(article);
      articleUrl = result.url;
      console.log(`   ✅ VK Article: ${articleUrl}`);
    } catch (err: any) {
      console.warn(`   ⚠️ VK Article creation failed: ${err.message}`);
      console.warn('   Continuing with rich wall post...');
    }
  } else {
    console.log('   ℹ️ VK cookies not found — using rich wall post format');
  }

  // 2. Upload ALL images for wall post carousel (cover + section images)
  const attachments: string[] = [];

  // 2a. Cover first
  if (coverImage) {
    console.log('🖼️  Uploading cover to VK...');
    const coverSrc = coverImage.processedImageUrl || coverImage.localPath || coverImage.originalImageUrl;
    const att = await uploadPhotoToVK(coverSrc);
    if (att) attachments.push(att);
  }

  // 2b. Section images (VK allows up to 10 total attachments)
  const remainingSlots = 10 - attachments.length;
  if (remainingSlots > 0 && content.sections?.length) {
    console.log(`🖼️  Uploading section images (up to ${remainingSlots})...`);
    for (let i = 0; i < content.sections.length && attachments.length < 10; i++) {
      const section = content.sections[i] as any;
      if (section.imageUrl) {
        try {
          const att = await uploadPhotoToVK(section.imageUrl);
          if (att) {
            attachments.push(att);
            console.log(`   ✅ Section ${i + 1} image uploaded`);
          }
        } catch (err: any) {
          console.warn(`   ⚠️ Section ${i + 1} image failed: ${err.message}`);
        }
      }
    }
  }

  console.log(`   📸 Total attachments: ${attachments.length}/10`);

  // 3. Build wall post text
  const message = articleUrl
    ? buildWallTextWithLink(title, content, articleUrl)
    : buildWallText(title, content);
  console.log(`   📝 Wall text: ${message.length} chars`);

  // 4. Post to VK wall
  console.log('📢 Posting to VK group wall...');
  const postUrl = await createWallPost(message, attachments);
  console.log(`   ✅ VK wall post: ${postUrl}`);

  // Return article URL if created, otherwise wall post URL
  return { url: articleUrl || postUrl };
}
