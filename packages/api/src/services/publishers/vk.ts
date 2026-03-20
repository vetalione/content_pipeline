/**
 * VK Publisher — Telegraph article + VK group wall post with cover
 *
 * Flow:
 * 1. Create full article on Telegra.ph (reuses Telegraph from telegram.ts)
 * 2. Upload cover photo to VK via photos API
 * 3. Post to VK group wall: cover photo + teaser + link to Telegraph article
 *
 * Env vars:
 *   VK_ACCESS_TOKEN  — group or user token with wall.post + photos permissions
 *   VK_GROUP_ID      — numeric group ID (without minus sign)
 */

import fs from 'fs';
import { ArticleContent, CoverImage } from '@content-pipeline/shared';
import {
  ArticleWithCover,
  getTelegraphToken,
  buildTelegraphContent,
  createTelegraphPage,
  resolveImagePath,
} from './telegram';

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
  photoAttachment: string | null
): Promise<string> {
  const groupId = getGroupId();

  const params: Record<string, string> = {
    owner_id: `-${groupId}`,
    from_group: '1',
    message,
  };

  if (photoAttachment) {
    params.attachments = photoAttachment;
  }

  const result = await vkApi('wall.post', params);
  const postId = result.post_id;
  const url = `https://vk.com/wall-${groupId}_${postId}`;
  return url;
}

// ── Main Entry Point ───────────────────────────────────────────────────────────

/**
 * Publish article to VK:
 * 1. Creates full article on Telegra.ph
 * 2. Uploads cover photo to VK
 * 3. Posts to group wall: cover + teaser + link to Telegraph
 */
export async function publishToVK(article: ArticleWithCover): Promise<{ url: string }> {
  const content = article.content as ArticleContent;
  if (!content) throw new Error('Article has no content');

  const title = content.title || article.celebrityName;
  const coverImage = article.coverImages?.find((c: CoverImage) => c.isSelected)
    || article.coverImages?.[0];

  console.log(`📰 Publishing to VK: "${title}"`);
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

  // 4. Upload cover photo to VK
  let photoAttachment: string | null = null;
  if (coverImage) {
    console.log('🖼️  Uploading cover to VK...');
    const coverSrc = coverImage.processedImageUrl || coverImage.localPath || coverImage.originalImageUrl;
    photoAttachment = await uploadPhotoToVK(coverSrc);
  }

  // 5. Build wall post message
  const teaser = content.teaser || '';
  const truncatedTeaser = teaser.length > 500 ? teaser.substring(0, 497) + '...' : teaser;
  const message = [
    `📰 ${title}`,
    '',
    truncatedTeaser,
    '',
    `👉 Читать полностью: ${telegraphUrl}`,
  ].join('\n');

  // 6. Post to VK wall
  console.log('📢 Posting to VK group wall...');
  const postUrl = await createWallPost(message, photoAttachment);
  console.log(`   ✅ VK wall post: ${postUrl}`);

  return { url: postUrl };
}
