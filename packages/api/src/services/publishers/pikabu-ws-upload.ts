/**
 * Pikabu binary WebSocket image upload client.
 *
 * Pikabu's editor uploads images via a proprietary binary protocol over
 * wss://ws.pikabu.ru/. This module reverse-engineers that protocol from
 * captured HAR files and replays it.
 *
 * Frame format (all multi-byte integers BIG-ENDIAN):
 *   [0..1] 0x55 0x91                 magic "VZ"
 *   [2..4] total frame size (3B)
 *   [5]    frame type
 *   <payload>
 *
 * Frame types:
 *   0x03 (→) RPC init (first frame of an uploadFile call, includes method,
 *             args and first chunk of file data)
 *   0x04 (→) Chunk (subsequent file data)
 *   0x05 (←) Ack (returns a new transfer_id that must be echoed on the
 *             NEXT chunk)
 *   0x06 (←) Response (final JSON with tmp_file_url)
 *   0x09 (←) Close
 *   0x0a (→) Close-ack
 *
 * Init (type 0x03) layout:
 *   [6..9]   frame_seq (4B) — used as implicit req_id for this upload
 *   [10..11] 0x00 0x0A      — length of method name
 *   [12..21] "uploadFile"
 *   [22..23] 0x00 0x7D      — constant marker (unknown meaning, just copy)
 *   [24..25] 0x00 0x14      — length of token (20 bytes)
 *   [26..45] <token>        — from GET /ajax.php?route=ws/get-upload-file-token
 *   [46]     0x01           — "has params" flag
 *   [47..48] 0x00 0x27      — params section length (39 bytes for our set)
 *   <params: (key_len:1 | key) (val_len:1 | val) ...>
 *     0x0B "source_type"  0x0B "story_image"
 *     0x0C "community_id" 0x01 "0"
 *   <first chunk of file data>
 *
 * Chunk (type 0x04) layout:
 *   [6..9]   frame_seq
 *   [10..13] req_id (= init's frame_seq)
 *   [14]     more_flag (0 = more chunks, 1 = last chunk)
 *   [15..18] transfer_id (echo of last ack's new_transfer_id)
 *   [19..21] chunk_data_len (3B)
 *   [22..]   chunk data
 *
 * Ack (type 0x05, 18B) layout:
 *   [6..7]   conn_id  (stable per WS connection)
 *   [8..9]   server seq
 *   [10..13] req_id
 *   [14..17] new_transfer_id
 *
 * Response (type 0x06) layout:
 *   [6..7]   conn_id  [8..9] seq  [10..13] req_id
 *   [14]     0x01
 *   [15..17] json_len (3B)
 *   [18..]   JSON body
 */

import WebSocket from 'ws';

const WS_URL = 'wss://ws.pikabu.ru/';
const TOKEN_URL = 'https://pikabu.ru/ajax.php?route=ws/get-upload-file-token';
const INIT_DATA_CAPACITY = 32025 - 88; // 31937 — file bytes in init frame
const CHUNK_DATA_SIZE = 1_000_000;     // 1 MB per regular chunk (observed max)

export interface UploadResult {
  tmp_file_name: string;
  tmp_file_url: string;
  small?: string;
  medium?: string;
  [key: string]: any;
}

/** Fetch the one-time upload token for the current session. */
export async function getUploadFileToken(cookieHeader: string, csrfToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    headers: {
      'Cookie': cookieHeader,
      'X-Csrf-Token': csrfToken,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://pikabu.ru/add',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) {
    throw new Error(`get-upload-file-token failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const data = (await res.json()) as any;
  const token = data?.data?.token || data?.token || data?.data;
  if (!token || typeof token !== 'string') {
    throw new Error(`get-upload-file-token unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return token;
}

/** Write a 3-byte big-endian unsigned integer into buf at offset. */
function writeUInt24BE(buf: Buffer, value: number, offset: number) {
  buf[offset] = (value >>> 16) & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = value & 0xff;
}

/** Build the INIT (type 0x03) frame for uploadFile, including first bytes of file data. */
function buildInitFrame(frameSeq: number, token: string, initData: Buffer): Buffer {
  if (token.length !== 20) {
    throw new Error(`Pikabu upload token must be 20 chars, got ${token.length}: ${token}`);
  }

  // Params bytes: each pair = len(1) + key + len(1) + value
  const p1Key = Buffer.from('source_type');    // 11
  const p1Val = Buffer.from('story_image');    // 11
  const p2Key = Buffer.from('community_id');   // 12
  const p2Val = Buffer.from('0');               // 1
  const paramsPayload = Buffer.concat([
    Buffer.from([p1Key.length]), p1Key,
    Buffer.from([p1Val.length]), p1Val,
    Buffer.from([p2Key.length]), p2Key,
    Buffer.from([p2Val.length]), p2Val,
  ]);
  // Must be 39 bytes given our fixed set
  if (paramsPayload.length !== 0x27) {
    throw new Error(`params payload unexpected length: ${paramsPayload.length}`);
  }

  const method = Buffer.from('uploadFile');
  const tokenBuf = Buffer.from(token, 'ascii');

  const header = Buffer.alloc(88);
  header[0] = 0x55; header[1] = 0x91;       // magic
  // size filled in below
  header[5] = 0x03;                          // type: RPC init
  header.writeUInt32BE(frameSeq, 6);         // frame_seq / implicit req_id
  header.writeUInt16BE(method.length, 10);   // = 0x000A
  method.copy(header, 12);                   // bytes 12..21
  header[22] = 0x00; header[23] = 0x7D;      // constant marker
  header.writeUInt16BE(tokenBuf.length, 24); // = 0x0014
  tokenBuf.copy(header, 26);                 // bytes 26..45
  header[46] = 0x01;                         // has-params flag
  header.writeUInt16BE(paramsPayload.length, 47); // = 0x0027
  paramsPayload.copy(header, 49);            // 49..87 (39 bytes)

  const totalSize = header.length + initData.length;
  writeUInt24BE(header, totalSize, 2);

  return Buffer.concat([header, initData]);
}

/** Build a CHUNK (type 0x04) frame. */
function buildChunkFrame(
  frameSeq: number,
  reqId: number,
  isLast: boolean,
  transferId: Buffer, // 4 bytes
  chunkData: Buffer
): Buffer {
  if (transferId.length !== 4) {
    throw new Error(`transferId must be 4 bytes, got ${transferId.length}`);
  }
  const header = Buffer.alloc(22);
  header[0] = 0x55; header[1] = 0x91;
  header[5] = 0x04;
  header.writeUInt32BE(frameSeq, 6);
  header.writeUInt32BE(reqId, 10);
  header[14] = isLast ? 0x01 : 0x00;
  transferId.copy(header, 15);
  writeUInt24BE(header, chunkData.length, 19);
  const totalSize = header.length + chunkData.length;
  writeUInt24BE(header, totalSize, 2);
  return Buffer.concat([header, chunkData]);
}

/** Build a client CLOSE-ACK (type 0x0A) frame. */
function buildCloseAckFrame(frameSeq: number, connId: Buffer, seq: Buffer): Buffer {
  if (connId.length !== 2 || seq.length !== 2) {
    throw new Error('connId and seq must be 2 bytes each');
  }
  const buf = Buffer.alloc(14);
  buf[0] = 0x55; buf[1] = 0x91;
  writeUInt24BE(buf, 14, 2); // total size
  buf[5] = 0x0a;
  buf.writeUInt32BE(frameSeq, 6);
  connId.copy(buf, 10);
  seq.copy(buf, 12);
  return buf;
}

interface ParsedFrame {
  type: number;
  payload: Buffer; // bytes after the 6-byte header
  total: number;
}

function parseFrame(msg: Buffer): ParsedFrame {
  if (msg.length < 6) throw new Error(`frame too short: ${msg.length}`);
  if (msg[0] !== 0x55 || msg[1] !== 0x91) {
    throw new Error(`bad magic: ${msg[0].toString(16)} ${msg[1].toString(16)}`);
  }
  const total = (msg[2] << 16) | (msg[3] << 8) | msg[4];
  const type = msg[5];
  if (total !== msg.length) {
    // Some servers may concatenate frames in one ws message; for Pikabu we observed 1:1
    // so we treat size mismatch as an error unless truncated
    if (total < msg.length) {
      // take just the first frame
      return { type, payload: msg.subarray(6, total), total };
    }
    throw new Error(`frame size mismatch: header=${total} actual=${msg.length}`);
  }
  return { type, payload: msg.subarray(6), total };
}

/**
 * Represents an open Pikabu upload WebSocket session that can upload
 * multiple files in sequence (frame_seq is continuous).
 */
export class PikabuUploadClient {
  private ws: WebSocket | null = null;
  private frameSeq = 0;
  private connId: Buffer | null = null;
  private token: string;
  private cookieHeader: string;

  // Pending queues: each upload tracks its own state
  private pendingAck: ((tid: Buffer) => void) | null = null;
  private pendingAckError: ((err: Error) => void) | null = null;
  private pendingResponse: ((json: any) => void) | null = null;
  private pendingResponseError: ((err: Error) => void) | null = null;

  private closed = false;

  constructor(cookieHeader: string, token: string) {
    this.cookieHeader = cookieHeader;
    this.token = token;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL, {
        headers: {
          'Cookie': this.cookieHeader,
          'Origin': 'https://pikabu.ru',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });
      this.ws = ws;

      ws.binaryType = 'nodebuffer';

      ws.on('open', () => resolve());
      ws.on('error', (err) => {
        if (!this.closed) {
          reject(err);
          const q = this.pendingAckError || this.pendingResponseError;
          if (q) q(err);
        }
      });
      ws.on('close', () => {
        this.closed = true;
      });
      ws.on('message', (data: Buffer) => this.onMessage(data));
    });
  }

  private onMessage(data: Buffer) {
    let frame: ParsedFrame;
    try {
      frame = parseFrame(data);
    } catch (err: any) {
      console.error('[pikabu-ws] parse error:', err.message, 'bytes:', data.slice(0, 32).toString('hex'));
      return;
    }

    switch (frame.type) {
      case 0x05: { // ACK for a chunk
        // payload: [conn_id 2B][seq 2B][req_id 4B][transfer_id 4B]
        if (frame.payload.length < 12) break;
        if (!this.connId) this.connId = Buffer.from(frame.payload.subarray(0, 2));
        const tid = Buffer.from(frame.payload.subarray(8, 12));
        if (this.pendingAck) {
          const cb = this.pendingAck;
          this.pendingAck = null;
          this.pendingAckError = null;
          cb(tid);
        }
        break;
      }
      case 0x06: { // Response JSON
        // payload: [conn_id 2B][seq 2B][req_id 4B][0x01][json_len 3B][JSON]
        if (frame.payload.length < 11) break;
        if (!this.connId) this.connId = Buffer.from(frame.payload.subarray(0, 2));
        const jsonLen = (frame.payload[9] << 16) | (frame.payload[10] << 8) | frame.payload[11];
        const jsonBytes = frame.payload.subarray(12, 12 + jsonLen);
        let parsed: any;
        try {
          parsed = JSON.parse(jsonBytes.toString('utf8'));
        } catch (err: any) {
          if (this.pendingResponseError) {
            this.pendingResponseError(new Error(`Invalid JSON from Pikabu WS: ${jsonBytes.slice(0, 200).toString('utf8')}`));
            this.pendingResponse = null;
            this.pendingResponseError = null;
          }
          return;
        }
        if (this.pendingResponse) {
          const cb = this.pendingResponse;
          this.pendingResponse = null;
          this.pendingResponseError = null;
          cb(parsed);
        }
        break;
      }
      case 0x09: { // Server close — respond with close-ack
        // payload: [conn_id 2B][seq 2B]
        if (frame.payload.length < 4) break;
        const connId = Buffer.from(frame.payload.subarray(0, 2));
        const seq = Buffer.from(frame.payload.subarray(2, 4));
        this.frameSeq += 1;
        const closeAck = buildCloseAckFrame(this.frameSeq, connId, seq);
        try {
          this.ws?.send(closeAck);
        } catch {
          /* ignore */
        }
        break;
      }
      default:
        // ignore other frame types
        break;
    }
  }

  private sendAndWaitForAck(frame: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WS not open'));
      }
      this.pendingAck = resolve;
      this.pendingAckError = reject;
      this.ws.send(frame, (err) => {
        if (err) {
          this.pendingAck = null;
          this.pendingAckError = null;
          reject(err);
        }
      });
    });
  }

  private waitForResponse(): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pendingResponse = resolve;
      this.pendingResponseError = reject;
    });
  }

  /** Upload a single file and return the JSON response from Pikabu. */
  async uploadFile(fileData: Buffer): Promise<UploadResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WS not connected');
    }

    // Split: init carries first 31937 bytes, chunks carry the rest.
    const initBytes = fileData.subarray(0, Math.min(INIT_DATA_CAPACITY, fileData.length));
    let rest = fileData.subarray(initBytes.length);

    this.frameSeq += 1;
    const reqId = this.frameSeq;
    const initFrame = buildInitFrame(this.frameSeq, this.token, initBytes);

    // Register response listener BEFORE sending (server sends 0x06 after last chunk ack)
    const responsePromise = this.waitForResponse();

    // Send init, get first transfer_id
    let transferId = await this.sendAndWaitForAck(initFrame);

    // If there is no more data at all, we still need a final flag=1 chunk
    // carrying 0 bytes to terminate. Otherwise iterate.
    if (rest.length === 0) {
      this.frameSeq += 1;
      const lastFrame = buildChunkFrame(this.frameSeq, reqId, true, transferId, Buffer.alloc(0));
      transferId = await this.sendAndWaitForAck(lastFrame);
    } else {
      while (rest.length > 0) {
        const take = Math.min(CHUNK_DATA_SIZE, rest.length);
        const chunk = rest.subarray(0, take);
        rest = rest.subarray(take);
        const isLast = rest.length === 0;
        this.frameSeq += 1;
        const chunkFrame = buildChunkFrame(this.frameSeq, reqId, isLast, transferId, chunk);
        transferId = await this.sendAndWaitForAck(chunkFrame);
      }
    }

    // After final chunk ack, server sends type 0x06 with JSON
    const result = await Promise.race<Promise<any>>([
      responsePromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out waiting for upload response')), 60_000)),
    ]);

    if (!result?.tmp_file_url) {
      throw new Error(`Pikabu upload response missing tmp_file_url: ${JSON.stringify(result).slice(0, 200)}`);
    }
    return result as UploadResult;
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * One-shot helper: open a WS connection, upload all files sequentially,
 * return the list of tmp_file_url values in the same order.
 */
export async function uploadImagesToPikabu(
  cookieHeader: string,
  csrfToken: string,
  files: Buffer[]
): Promise<UploadResult[]> {
  if (files.length === 0) return [];
  const token = await getUploadFileToken(cookieHeader, csrfToken);
  const client = new PikabuUploadClient(cookieHeader, token);
  try {
    await client.connect();
    const results: UploadResult[] = [];
    for (const f of files) {
      const r = await client.uploadFile(f);
      results.push(r);
    }
    return results;
  } finally {
    client.close();
  }
}
