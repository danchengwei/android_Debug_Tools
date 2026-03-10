/**
 * APK 反编译服务：解压 APK、解析 DEX 提取类名，供搜索与大模型分析使用。
 * 仅在浏览器端执行，APK 不上传服务器。
 */

import JSZip from 'jszip';
import { DecompileInfo } from '../types';

const DEX_MAGIC = new Uint8Array([0x64, 0x65, 0x78, 0x0a]); // "dex\n"

function isDexFile(buf: Uint8Array): boolean {
  if (buf.length < 4) return false;
  return buf[0] === DEX_MAGIC[0] && buf[1] === DEX_MAGIC[1] && buf[2] === DEX_MAGIC[2] && buf[3] === DEX_MAGIC[3];
}

/** 读取 uleb128，返回 [value, bytesConsumed] */
function readUleb128(data: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < data.length) {
    const b = data[i++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift >= 35) break;
  }
  return [result, i - offset];
}

/** DEX 使用 MUTF-8：0 编码为 0xC0 0x80；string_data 常以 0x00 结尾，设上限防越界。 */
const MAX_STRING_BYTES = 8192;

function readMutf8UntilNull(data: Uint8Array, offset: number): string {
  const arr: number[] = [];
  let i = offset;
  const end = Math.min(data.length, offset + MAX_STRING_BYTES);
  while (i < end && data[i] !== 0x00) {
    if (data[i] === 0xc0 && i + 1 < end && data[i + 1] === 0x80) {
      arr.push(0);
      i += 2;
    } else {
      arr.push(data[i]);
      i++;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(arr));
  } catch {
    return String.fromCharCode(...arr);
  }
}

/** 从 DEX 缓冲区解析所有类描述符（如 Lcom/example/Main;） */
function parseDexClasses(buf: Uint8Array): string[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 0x70) return [];

  const stringIdsSize = view.getUint32(0x38, true);
  const stringIdsOff = view.getUint32(0x3c, true);
  const typeIdsSize = view.getUint32(0x44, true);
  const typeIdsOff = view.getUint32(0x48, true);
  const classDefsSize = view.getUint32(0x58, true);
  const classDefsOff = view.getUint32(0x5c, true);

  if (stringIdsSize === 0 || classDefsSize === 0) return [];

  const stringOffsets: number[] = [];
  for (let i = 0; i < stringIdsSize; i++) {
    const off = view.getUint32(stringIdsOff + i * 4, true);
    stringOffsets.push(off);
  }

  const strings: string[] = [];
  for (let i = 0; i < stringOffsets.length; i++) {
    const off = stringOffsets[i];
    if (off >= buf.length) {
      strings.push('');
      continue;
    }
    const [, n] = readUleb128(buf, off); // uleb128 为 utf16 size，n 为占用字节数
    const str = readMutf8UntilNull(buf, off + n);
    strings.push(str);
  }

  const typeIds: number[] = [];
  for (let i = 0; i < typeIdsSize; i++) {
    const descriptorIdx = view.getUint32(typeIdsOff + i * 4, true);
    typeIds.push(descriptorIdx);
  }

  const classes: string[] = [];
  for (let i = 0; i < classDefsSize; i++) {
    const classDefOff = classDefsOff + i * 32;
    if (classDefOff + 4 > buf.length) break;
    const classIdx = view.getUint32(classDefOff, true);
    if (classIdx < typeIds.length) {
      const descriptorIdx = typeIds[classIdx];
      if (descriptorIdx < strings.length) {
        const desc = strings[descriptorIdx];
        if (desc && desc.startsWith('L') && desc.endsWith(';')) classes.push(desc);
      }
    }
  }
  return [...new Set(classes)];
}

/**
 * 从 APK 文件（File 或 ArrayBuffer）解析出所有 DEX 中的类名。
 */
export async function decompileApk(file: File): Promise<DecompileInfo> {
  const zip = await JSZip.loadAsync(file);
  const classes: string[] = [];
  let packageName: string | null = null;

  const dexNames = Object.keys(zip.files).filter((n) => n.toLowerCase().endsWith('.dex'));
  for (const name of dexNames) {
    const entry = zip.file(name);
    if (!entry) continue;
    const buf = await entry.async('uint8array');
    if (!isDexFile(buf)) continue;
    const list = parseDexClasses(buf);
    classes.push(...list);
  }

  const manifestEntry = zip.file('AndroidManifest.xml');
  if (manifestEntry) {
    try {
      const raw = await manifestEntry.async('uint8array');
      packageName = parsePackageFromManifest(raw) ?? null;
    } catch {
      // 二进制 manifest 解析失败时忽略
    }
  }

  if (!packageName && classes.length > 0) {
    const first = classes.find((c) => c.startsWith('L') && c.includes('/'));
    if (first) {
      const inner = first.slice(1, -1);
      const lastSlash = inner.lastIndexOf('/');
      packageName = lastSlash >= 0 ? inner.slice(0, lastSlash).replace(/\//g, '.') : inner.replace(/\//g, '.');
    }
  }

  return {
    packageName,
    classes: [...new Set(classes)].sort(),
  };
}

/**
 * 简单从二进制 AndroidManifest 中查找 package 属性（AXML 中常见 pattern）。
 * 仅作启发式解析，不保证所有 APK 都能拿到。
 */
function parsePackageFromManifest(buf: Uint8Array): string | null {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const str = decoder.decode(buf);
  const match = str.match(/package[\s='"]*([a-zA-Z0-9_.]+)/);
  return match ? match[1] : null;
}
