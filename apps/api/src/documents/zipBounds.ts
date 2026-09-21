import { inflateRawSync } from "node:zlib";
import { MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED_BYTES } from "./documentLimits.ts";
import { DocumentParseError } from "./documentParseError.ts";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  declaredSize: number;
  localHeaderOffset: number;
}

function readEntries(bytes: Buffer): ZipEntry[] {
  // The end record sits at the very end, before an optional comment.
  const searchStart = Math.max(0, bytes.length - END_RECORD_SIZE - MAX_COMMENT_LENGTH);
  let endOffset = -1;
  for (let offset = bytes.length - END_RECORD_SIZE; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset === -1) throw new DocumentParseError("corrupt");

  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const directoryOffset = bytes.readUInt32LE(endOffset + 16);
  // 0xffff and 0xffffffff mean Zip64, which an ordinary Word document never needs.
  if (entryCount === 0xffff || directoryOffset === 0xffffffff)
    throw new DocumentParseError("too_large");
  if (entryCount > MAX_ZIP_ENTRIES) throw new DocumentParseError("too_large");

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new DocumentParseError("corrupt");
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    if (offset + 46 + nameLength > bytes.length) throw new DocumentParseError("corrupt");
    entries.push({
      name: bytes.toString("utf8", offset + 46, offset + 46 + nameLength),
      method: bytes.readUInt16LE(offset + 10),
      compressedSize: bytes.readUInt32LE(offset + 20),
      declaredSize: bytes.readUInt32LE(offset + 24),
      localHeaderOffset: bytes.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Checks a DOCX archive before anything unzips it for real. The entry count and the sizes the
 * archive declares are checked first, and then every entry is actually inflated with a hard output
 * cap, because a declared size is only a claim: a zip bomb lies about it. The whole archive may
 * inflate to no more than `MAX_ZIP_UNCOMPRESSED_BYTES`, however it is arranged.
 *
 * Returns the entry names, so the caller can check the file really is a Word document.
 */
export function checkZipBounds(bytes: Buffer): string[] {
  const entries = readEntries(bytes);

  const declaredTotal = entries.reduce((total, entry) => total + entry.declaredSize, 0);
  if (declaredTotal > MAX_ZIP_UNCOMPRESSED_BYTES) throw new DocumentParseError("too_large");

  let inflatedTotal = 0;
  for (const entry of entries) {
    if (entry.method !== 0 && entry.method !== 8) throw new DocumentParseError("corrupt");
    if (entry.localHeaderOffset + 30 > bytes.length) throw new DocumentParseError("corrupt");
    if (bytes.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_HEADER) {
      throw new DocumentParseError("corrupt");
    }
    const dataStart =
      entry.localHeaderOffset +
      30 +
      bytes.readUInt16LE(entry.localHeaderOffset + 26) +
      bytes.readUInt16LE(entry.localHeaderOffset + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) throw new DocumentParseError("corrupt");
    const compressed = bytes.subarray(dataStart, dataEnd);

    const remaining = MAX_ZIP_UNCOMPRESSED_BYTES - inflatedTotal;
    if (entry.method === 0) {
      inflatedTotal += compressed.length;
    } else {
      try {
        // One byte past what is left, so going over is noticed rather than silently cut.
        inflatedTotal += inflateRawSync(compressed, { maxOutputLength: remaining + 1 }).length;
      } catch (error) {
        const isOverLimit =
          error instanceof RangeError ||
          (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE";
        throw new DocumentParseError(isOverLimit ? "too_large" : "corrupt");
      }
    }
    if (inflatedTotal > MAX_ZIP_UNCOMPRESSED_BYTES) throw new DocumentParseError("too_large");
  }
  return entries.map((entry) => entry.name);
}
