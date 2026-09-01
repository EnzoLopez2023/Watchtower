import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const MASTER_PATH = join(PUBLIC, 'watchtower-icon-1024.png');
const APPLE_PATH = join(PUBLIC, 'apple-touch-icon.png');
const FAVICON_PATH = join(PUBLIC, 'favicon.ico');
const MASTER_SHA256 = 'a49c72aad165d0537ecd6475f079f8b31af63fc8e3b70d13986dd071262031a3';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHECK = process.argv.includes('--check');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--check');

if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument${unknownArguments.length === 1 ? '' : 's'}: ${unknownArguments.join(', ')}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function decodePng(bytes) {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Master is not a PNG');
  }

  let offset = PNG_SIGNATURE.length;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const compressed = [];

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('Master PNG contains a truncated chunk');
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (crcOffset + 4 > bytes.length) throw new Error(`Master PNG ${type} chunk is truncated`);

    const crcInput = bytes.subarray(offset + 4, dataEnd);
    if (bytes.readUInt32BE(crcOffset) !== crc32(crcInput)) {
      throw new Error(`Master PNG ${type} chunk failed its CRC check`);
    }

    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset = crcOffset + 4;
  }

  if (width === undefined || height === undefined) throw new Error('Master PNG has no IHDR chunk');
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error('Master PNG must be a non-interlaced 8-bit RGB or RGBA image');
  }
  if (compressed.length === 0) throw new Error('Master PNG has no image data');

  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(compressed));
  if (raw.length !== height * (stride + 1)) throw new Error('Master PNG image data has an unexpected length');

  const decoded = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * (stride + 1);
    const filter = raw[sourceRow];
    const targetRow = y * stride;

    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[sourceRow + 1 + x];
      const left = x >= channels ? decoded[targetRow + x - channels] : 0;
      const above = y > 0 ? decoded[targetRow - stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? decoded[targetRow - stride + x - channels] : 0;
      let value;

      switch (filter) {
        case 0:
          value = encoded;
          break;
        case 1:
          value = encoded + left;
          break;
        case 2:
          value = encoded + above;
          break;
        case 3:
          value = encoded + Math.floor((left + above) / 2);
          break;
        case 4:
          value = encoded + paeth(left, above, upperLeft);
          break;
        default:
          throw new Error(`Master PNG uses unsupported filter ${filter}`);
      }

      decoded[targetRow + x] = value & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let source = 0, target = 0; source < decoded.length; source += channels, target += 4) {
    rgba[target] = decoded[source];
    rgba[target + 1] = decoded[source + 1];
    rgba[target + 2] = decoded[source + 2];
    rgba[target + 3] = channels === 4 ? decoded[source + 3] : 255;
  }

  return { width, height, rgba };
}

function resizeBox(source, width, height) {
  const output = Buffer.alloc(width * height * 4);
  const denominator = source.width * source.height;

  for (let targetY = 0; targetY < height; targetY += 1) {
    const targetTop = targetY * source.height;
    const targetBottom = (targetY + 1) * source.height;
    const sourceTop = Math.floor(targetTop / height);
    const sourceBottom = Math.ceil(targetBottom / height);

    for (let targetX = 0; targetX < width; targetX += 1) {
      const targetLeft = targetX * source.width;
      const targetRight = (targetX + 1) * source.width;
      const sourceLeft = Math.floor(targetLeft / width);
      const sourceRight = Math.ceil(targetRight / width);
      const sums = [0, 0, 0, 0];

      for (let sourceY = sourceTop; sourceY < sourceBottom; sourceY += 1) {
        const overlapY =
          Math.min(targetBottom, (sourceY + 1) * height) - Math.max(targetTop, sourceY * height);
        for (let sourceX = sourceLeft; sourceX < sourceRight; sourceX += 1) {
          const overlapX =
            Math.min(targetRight, (sourceX + 1) * width) - Math.max(targetLeft, sourceX * width);
          const weight = overlapX * overlapY;
          const sourceOffset = (sourceY * source.width + sourceX) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            sums[channel] += source.rgba[sourceOffset + channel] * weight;
          }
        }
      }

      const targetOffset = (targetY * width + targetX) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        output[targetOffset + channel] = Math.floor((sums[channel] + denominator / 2) / denominator);
      }
    }
  }

  return output;
}

function encodePng(width, height, rgba, includeAlpha) {
  const channels = includeAlpha ? 4 : 3;
  const rows = Buffer.alloc(height * (1 + width * channels));

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (1 + width * channels);
    rows[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (y * width + x) * 4;
      const targetOffset = rowOffset + 1 + x * channels;
      rgba.copy(rows, targetOffset, sourceOffset, sourceOffset + channels);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = includeAlpha ? 6 : 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(frames) {
  const directorySize = 6 + frames.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  let imageOffset = directorySize;
  frames.forEach(({ size, bytes }, index) => {
    const entryOffset = 6 + index * 16;
    header[entryOffset] = size === 256 ? 0 : size;
    header[entryOffset + 1] = size === 256 ? 0 : size;
    header[entryOffset + 2] = 0;
    header[entryOffset + 3] = 0;
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(bytes.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += bytes.length;
  });

  return Buffer.concat([header, ...frames.map(({ bytes }) => bytes)]);
}

function buildDerivatives(master) {
  const applePixels = resizeBox(master, 180, 180);
  const apple = encodePng(180, 180, applePixels, false);
  const favicon = encodeIco(
    [16, 32, 48].map((size) => ({
      size,
      bytes: encodePng(size, size, resizeBox(master, size, size), true),
    })),
  );
  return { apple, favicon };
}

function assertFileBytes(path, expected, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing at ${relative(ROOT, path)}`);
  const actual = readFileSync(path);
  if (!actual.equals(expected)) {
    throw new Error(
      `${label} drifted at ${relative(ROOT, path)} (expected ${sha256(expected)}, received ${sha256(actual)})`,
    );
  }
}

function readTree(directory, extensions) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      files.push(...readTree(path, extensions));
    } else if (extensions.has(extname(entry))) {
      files.push(path);
    }
  }
  return files;
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}=(["'])(.*?)\\1`, 'i'))?.[2] ?? null;
}

function validateReferences() {
  const htmlPath = join(ROOT, 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  const identityLinks = links.filter((tag) => {
    const rel = (attribute(tag, 'rel') ?? '').split(/\s+/);
    return rel.includes('icon') || rel.includes('apple-touch-icon');
  });
  const required = [
    {
      href: '/favicon.ico',
      rel: 'icon',
      sizes: '16x16 32x32 48x48',
      type: 'image/x-icon',
    },
    {
      href: '/watchtower-icon-1024.png',
      rel: 'icon',
      sizes: '1024x1024',
      type: 'image/png',
    },
    {
      href: '/apple-touch-icon.png',
      rel: 'apple-touch-icon',
      sizes: '180x180',
      type: 'image/png',
    },
  ];

  for (const expected of required) {
    const matching = links.filter((tag) => attribute(tag, 'href') === expected.href);
    if (matching.length !== 1) {
      throw new Error(`index.html must reference ${expected.href} exactly once`);
    }
    const [tag] = matching;
    for (const [name, value] of Object.entries(expected)) {
      if (attribute(tag, name) !== value) {
        throw new Error(`index.html ${expected.href} link must set ${name}="${value}"`);
      }
    }
  }

  const approvedHrefs = new Set(required.map(({ href }) => href));
  for (const tag of identityLinks) {
    const href = attribute(tag, 'href');
    if (href !== null && !approvedHrefs.has(href)) {
      throw new Error(`index.html contains an unapproved icon identity: ${href}`);
    }
  }

  const manifestPaths = readTree(join(ROOT, 'public'), new Set(['.webmanifest'])).concat(
    readdirSync(join(ROOT, 'public'))
      .filter((name) => /^manifest.*\.json$/i.test(name))
      .map((name) => join(ROOT, 'public', name)),
  );
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    for (const icon of icons) {
      if (typeof icon?.src !== 'string' || !approvedHrefs.has(icon.src)) {
        throw new Error(`${relative(ROOT, manifestPath)} contains an unapproved icon identity`);
      }
    }
  }

  const brandPath = join(ROOT, 'src', 'components', 'WatchtowerBrand.tsx');
  const landingPath = join(ROOT, 'src', 'marketing', 'LandingPage.tsx');
  const shellPath = join(ROOT, 'src', 'app', 'AppShell.tsx');
  const brand = readFileSync(brandPath, 'utf8');
  if (!brand.includes("const WATCHTOWER_ICON = '/watchtower-icon-1024.png';")) {
    throw new Error('WatchtowerBrand must use the immutable master icon');
  }
  if (!readFileSync(landingPath, 'utf8').includes('<WatchtowerBrand')) {
    throw new Error('LandingPage must use WatchtowerBrand');
  }
  if (!readFileSync(shellPath, 'utf8').includes('<WatchtowerBrand')) {
    throw new Error('AppShell must use WatchtowerBrand');
  }

  const sourceFiles = readTree(join(ROOT, 'src'), new Set(['.ts', '.tsx', '.js', '.jsx', '.css']));
  for (const sourcePath of sourceFiles) {
    const source = readFileSync(sourcePath, 'utf8');
    if (
      /borderLeft:\s*['"]8px solid transparent['"]/.test(source) &&
      /borderBottom:\s*`14px solid/.test(source)
    ) {
      throw new Error(`${relative(ROOT, sourcePath)} still contains the retired triangle brand mark`);
    }
  }
}

const masterBytes = readFileSync(MASTER_PATH);
const masterHash = sha256(masterBytes);
if (masterHash !== MASTER_SHA256) {
  throw new Error(`Master checksum mismatch (expected ${MASTER_SHA256}, received ${masterHash})`);
}

const master = decodePng(masterBytes);
if (master.width !== 1024 || master.height !== 1024) {
  throw new Error(`Master dimensions must be 1024x1024, received ${master.width}x${master.height}`);
}
for (let alpha = 3; alpha < master.rgba.length; alpha += 4) {
  if (master.rgba[alpha] !== 255) throw new Error('Master must be fully opaque');
}

const { apple, favicon } = buildDerivatives(master);
if (CHECK) {
  assertFileBytes(APPLE_PATH, apple, 'Apple touch icon');
  assertFileBytes(FAVICON_PATH, favicon, 'Favicon');
  validateReferences();
  console.log(`Icon check passed: ${MASTER_SHA256}`);
} else {
  writeFileSync(APPLE_PATH, apple);
  writeFileSync(FAVICON_PATH, favicon);
  console.log(`Generated ${relative(ROOT, APPLE_PATH)} and ${relative(ROOT, FAVICON_PATH)}`);
}
