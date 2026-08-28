// services/vision/phash.js
// Real DCT-II based perceptual hash. Zero dependencies (node:zlib is stdlib).
//
// Pipeline (the classic pHash): decode -> grayscale -> resize to 32x32 (box
// filter) -> 2D DCT-II -> keep the top-left 8x8 low-frequency block minus the
// DC term -> threshold at the median -> 64 bits -> 16 hex chars.
//
// SPEC-ASSUMPTION: SPEC §5.4 fixes the phash contract as an opaque string; we
// emit 16 lowercase hex chars (64 bits) so Hamming distance is comparable in SQL
// (see hamming_hex() in 0003_functions.sql).

import zlib from 'node:zlib';

export const PHASH_BITS = 64;
export const PHASH_HEX_LEN = 16;

/* ------------------------------------------------------------------ DCT-II */
const cosTables = new Map();
function cosTable(N) {
  let t = cosTables.get(N);
  if (t) return t;
  t = new Float64Array(N * N);
  for (let u = 0; u < N; u++)
    for (let x = 0; x < N; x++) t[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  cosTables.set(N, t);
  return t;
}

/** Separable 2D DCT-II of an NxN Float64Array. Returns NxN coefficients. */
export function dct2d(src, N) {
  const C = cosTable(N);
  const tmp = new Float64Array(N * N);
  const out = new Float64Array(N * N);
  // rows
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += src[y * N + x] * C[u * N + x];
      tmp[y * N + u] = s * (u === 0 ? Math.SQRT1_2 : 1);
    }
  }
  // cols
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += tmp[y * N + u] * C[v * N + y];
      out[v * N + u] = s * (v === 0 ? Math.SQRT1_2 : 1) * (2 / N);
    }
  }
  return out;
}

/* --------------------------------------------------------------- resampling */
/** Box-filter resize of a single-channel image to dstW x dstH. */
export function resizeGray(gray, w, h, dstW, dstH) {
  const out = new Float64Array(dstW * dstH);
  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor((dy * h) / dstH);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * h) / dstH));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor((dx * w) / dstW);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * w) / dstW));
      let s = 0, n = 0;
      for (let y = y0; y < y1 && y < h; y++)
        for (let x = x0; x < x1 && x < w; x++) { s += gray[y * w + x]; n++; }
      out[dy * dstW + dx] = n ? s / n : 0;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- decoders */
function u32(b, i) { return (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0; }

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPng(b) { return PNG_SIG.every((v, i) => b[i] === v); }
export function isBmp(b) { return b[0] === 0x42 && b[1] === 0x4d; }
export function isJpeg(b) { return b[0] === 0xff && b[1] === 0xd8; }
export function isPnm(b) { return b[0] === 0x50 && b[1] >= 0x31 && b[1] <= 0x36; }

/** Full baseline PNG decode -> {gray, width, height}. Handles colour types
 *  0/2/3/4/6 at 8 bits, all five filter types, no interlace. */
export function decodePng(buf) {
  if (!isPng(buf)) throw new Error('not a png');
  let i = 8, width = 0, height = 0, depth = 8, ctype = 6, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (i < buf.length) {
    const len = u32(buf, i);
    const type = String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      width = u32(data, 0); height = u32(data, 4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (depth !== 8) throw new Error('png: only 8-bit depth supported, got ' + depth);
  if (interlace) throw new Error('png: interlaced not supported');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error('png: colour type ' + ctype);
  const bpp = channels;
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      switch (ft) {
        case 0: break;
        case 1: v = v + a; break;
        case 2: v = v + b; break;
        case 3: v = v + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('png: filter ' + ft);
      }
      cur[x] = v & 0xff;
    }
  }
  const gray = new Float64Array(width * height);
  for (let n = 0, o = 0; n < width * height; n++, o += bpp) {
    let r, g, b2;
    if (ctype === 3) { const idx = px[o] * 3; r = palette[idx]; g = palette[idx + 1]; b2 = palette[idx + 2]; }
    else if (ctype === 0 || ctype === 4) { r = g = b2 = px[o]; }
    else { r = px[o]; g = px[o + 1]; b2 = px[o + 2]; }
    gray[n] = 0.299 * r + 0.587 * g + 0.114 * b2;
  }
  return { gray, width, height };
}

/** Uncompressed BMP (24/32-bit, bottom-up or top-down). */
export function decodeBmp(buf) {
  const off = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  let h = buf.readInt32LE(22);
  const bits = buf.readUInt16LE(28);
  const flip = h > 0; h = Math.abs(h);
  if (bits !== 24 && bits !== 32) throw new Error('bmp: ' + bits + 'bpp unsupported');
  const bpp = bits / 8, stride = Math.ceil((w * bpp) / 4) * 4;
  const gray = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = flip ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const o = off + sy * stride + x * bpp;
      gray[y * w + x] = 0.114 * buf[o] + 0.587 * buf[o + 1] + 0.299 * buf[o + 2];
    }
  }
  return { gray, width: w, height: h };
}

/** Binary PGM/PPM (P5/P6) — handy for tests and for ffmpeg/ImageMagick pipes. */
export function decodePnm(buf) {
  const kind = buf[1] - 0x30;
  let i = 2; const nums = [];
  const next = () => {
    while (i < buf.length) {
      const c = buf[i];
      if (c === 0x23) { while (i < buf.length && buf[i] !== 0x0a) i++; }
      else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
    let s = '';
    while (i < buf.length && buf[i] > 0x20) s += String.fromCharCode(buf[i++]);
    return parseInt(s, 10);
  };
  nums.push(next(), next(), next()); i++;
  const [w, h] = nums;
  const ch = kind === 6 ? 3 : 1;
  const gray = new Float64Array(w * h);
  for (let n = 0; n < w * h; n++) {
    const o = i + n * ch;
    gray[n] = ch === 1 ? buf[o] : 0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2];
  }
  return { gray, width: w, height: h };
}

/** Baseline JPEG: decode DC coefficients only -> one luma sample per 8x8 block.
 *  That is exactly the low-frequency information pHash wants, at 1/64 the cost,
 *  and it needs no IDCT, no upsampling and no dependencies.
 *  SPEC-ASSUMPTION: progressive JPEGs are rejected (callers should transcode). */
export function decodeJpegDc(buf) {
  let i = 2;
  const qt = {}, huff = {};
  let frame = null;
  const readU16 = (p) => (buf[p] << 8) | buf[p + 1];
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1]; i += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const len = readU16(i);
    const seg = buf.subarray(i + 2, i + len);
    if (marker === 0xc4) {                               // DHT
      let p = 0;
      while (p < seg.length) {
        const id = seg[p++];
        const counts = seg.subarray(p, p + 16); p += 16;
        let total = 0; for (const c of counts) total += c;
        const symbols = seg.subarray(p, p + total); p += total;
        // build code -> symbol map
        const table = new Map();
        let code = 0, k = 0;
        for (let l = 1; l <= 16; l++) {
          for (let n = 0; n < counts[l - 1]; n++) table.set(l + ':' + code++, symbols[k++]);
          code <<= 1;
        }
        huff[id] = table;
      }
    } else if (marker === 0xdb) {                        // DQT
      let p = 0;
      while (p < seg.length) {
        const pq = seg[p] >> 4, tq = seg[p] & 15; p++;
        const t = new Int32Array(64);
        for (let n = 0; n < 64; n++) { t[n] = pq ? readU16(i + 2 + p) : seg[p]; p += pq ? 2 : 1; }
        qt[tq] = t;
      }
    } else if (marker === 0xc0 || marker === 0xc1) {      // SOF0/1 baseline
      const h = readU16(2 + 0 + 1 + 0 + i) ; // placeholder, real parse below
      frame = { h: readU16(i + 3), w: readU16(i + 5), comps: [] };
      const n = seg[5];
      for (let c = 0; c < n; c++) {
        const o = 6 + c * 3;
        frame.comps.push({ id: seg[o], hs: seg[o + 1] >> 4, vs: seg[o + 1] & 15, tq: seg[o + 2] });
      }
    } else if (marker === 0xc2) {
      throw new Error('jpeg: progressive not supported');
    } else if (marker === 0xda) {                        // SOS
      const ns = seg[0];
      const scan = [];
      for (let c = 0; c < ns; c++) scan.push({ id: seg[1 + c * 2], td: seg[2 + c * 2] >> 4 });
      return jpegScanDc(buf, i + len, frame, scan, huff, qt);
    }
    i += len;
  }
  throw new Error('jpeg: no scan found');
}

function jpegScanDc(buf, start, frame, scan, huff, qt) {
  if (!frame) throw new Error('jpeg: no frame header');
  const hmax = Math.max(...frame.comps.map((c) => c.hs));
  const vmax = Math.max(...frame.comps.map((c) => c.vs));
  const mcuW = 8 * hmax, mcuH = 8 * vmax;
  const mcusX = Math.ceil(frame.w / mcuW), mcusY = Math.ceil(frame.h / mcuH);
  const y0 = frame.comps[0];
  const bw = mcusX * y0.hs, bh = mcusY * y0.vs;
  const luma = new Float64Array(bw * bh);

  let p = start, bitBuf = 0, bitCnt = 0;
  const nextBit = () => {
    if (bitCnt === 0) {
      if (p >= buf.length) return 0;
      let b = buf[p++];
      if (b === 0xff) {
        const m = buf[p];
        if (m === 0x00) p++;
        else if (m >= 0xd0 && m <= 0xd7) { p++; b = buf[p++]; }
        else return 0;
      }
      bitBuf = b; bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  };
  const decodeHuff = (table) => {
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | nextBit();
      const s = table.get(l + ':' + code);
      if (s !== undefined) return s;
    }
    throw new Error('jpeg: bad huffman code');
  };
  const receiveExtend = (s) => {
    if (s === 0) return 0;
    let v = 0;
    for (let n = 0; n < s; n++) v = (v << 1) | nextBit();
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  };

  const pred = new Map(frame.comps.map((c) => [c.id, 0]));
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (const comp of frame.comps) {
        const sc = scan.find((s) => s.id === comp.id) || scan[0];
        const table = huff[sc.td] || huff[0];
        for (let v = 0; v < comp.vs; v++) {
          for (let h = 0; h < comp.hs; h++) {
            const s = decodeHuff(table);
            const diff = receiveExtend(s);
            const dc = pred.get(comp.id) + diff;
            pred.set(comp.id, dc);
            // skip the AC coefficients of this block
            const acTable = huff[16 + (sc.td)] || huff[16] || table;
            let k = 1;
            while (k < 64) {
              const rs = decodeHuff(acTable);
              const r = rs >> 4, sz = rs & 15;
              if (sz === 0) { if (r === 15) { k += 16; continue; } break; }
              k += r + 1;
              receiveExtend(sz);
            }
            if (comp === frame.comps[0]) {
              const q = (qt[comp.tq] && qt[comp.tq][0]) || 16;
              const val = dc * q / 8 + 128;             // block mean luminance
              const bx = mx * comp.hs + h, by = my * comp.vs + v;
              if (bx < bw && by < bh) luma[by * bw + bx] = Math.max(0, Math.min(255, val));
            }
          }
        }
      }
    }
  }
  return { gray: luma, width: bw, height: bh };
}

/** Format-sniffing decode. Throws with a clear message on unsupported input. */
export function decodeToGray(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (isPng(b)) return decodePng(b);
  if (isJpeg(b)) return decodeJpegDc(b);
  if (isBmp(b)) return decodeBmp(b);
  if (isPnm(b)) return decodePnm(b);
  throw new Error('unsupported image format (png/jpeg/bmp/pnm only)');
}

/* --------------------------------------------------------------- the hash */
function bitsToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
  }
  return hex;
}

/** pHash from an already-grayscale plane. */
export function pHashFromGray(gray, width, height, { size = 32, low = 8 } = {}) {
  const small = resizeGray(gray, width, height, size, size);
  const coef = dct2d(small, size);
  const vals = [];
  for (let v = 0; v < low; v++)
    for (let u = 0; u < low; u++) if (u || v) vals.push(coef[v * size + u]);
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const bits = vals.map((x) => (x > median ? 1 : 0));
  bits.push(0);                                  // pad 63 -> 64 bits
  return bitsToHex(bits);
}

/** pHash from encoded image bytes. */
export function pHash(bytes, opts) {
  const { gray, width, height } = decodeToGray(bytes);
  return pHashFromGray(gray, width, height, opts);
}

/** Hamming distance between two hex phashes (mirrors SQL hamming_hex). */
export function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 15;
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

export default { pHash, pHashFromGray, hammingHex, decodeToGray, dct2d, resizeGray };
