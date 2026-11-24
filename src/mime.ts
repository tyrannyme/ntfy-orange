import { isValidUtf8 } from "./util";

// Magic-byte sniffing for the types clients care about (image previews on Android,
// APK installs, audio/video players). Anything else falls back to the file extension.
const SIGNATURES: [type: string, ext: string, test: (b: Uint8Array) => boolean][] = [
  ["image/png", "png", (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["image/jpeg", "jpg", (b) => starts(b, [0xff, 0xd8, 0xff])],
  ["image/gif", "gif", (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")],
  ["image/webp", "webp", (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")],
  ["image/bmp", "bmp", (b) => ascii(b, 0, "BM") && b.length > 14],
  ["image/heic", "heic", (b) => ascii(b, 4, "ftypheic") || ascii(b, 4, "ftypheix") || ascii(b, 4, "ftypmif1")],
  ["image/avif", "avif", (b) => ascii(b, 4, "ftypavif")],
  ["application/pdf", "pdf", (b) => ascii(b, 0, "%PDF-")],
  ["audio/mpeg", "mp3", (b) => ascii(b, 0, "ID3") || isMp3Frame(b)],
  ["audio/ogg", "ogg", (b) => ascii(b, 0, "OggS")],
  ["audio/wave", "wav", (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")],
  ["audio/flac", "flac", (b) => ascii(b, 0, "fLaC")],
  ["video/mp4", "mp4", (b) => ascii(b, 4, "ftyp")],
  ["video/webm", "webm", (b) => starts(b, [0x1a, 0x45, 0xdf, 0xa3])],
  ["application/gzip", "gz", (b) => starts(b, [0x1f, 0x8b])],
  ["application/x-7z-compressed", "7z", (b) => starts(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
  ["application/x-executable", "bin", (b) => starts(b, [0x7f, 0x45, 0x4c, 0x46])],
];

const EXTENSIONS: Record<string, string> = {
  apk: "application/vnd.android.package-archive",
  zip: "application/zip",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  md: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  svg: "image/svg+xml",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  m4a: "audio/mp4",
  opus: "audio/ogg",
};

// MPEG-1/2 Layer III frame header: sync bits, layer 3, and a real (not free/bad) bitrate.
function isMp3Frame(b: Uint8Array): boolean {
  const [b0 = 0, b1 = 0, b2 = 0] = b;
  const bitrate = b2 >> 4;
  return b0 === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) === 0x02 && bitrate !== 0 && bitrate !== 15;
}

function starts(b: Uint8Array, sig: number[]): boolean {
  return sig.every((v, i) => b[i] === v);
}

function ascii(b: Uint8Array, offset: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) if (b[offset + i] !== s.charCodeAt(i)) return false;
  return true;
}

export interface Detected {
  type: string;
  ext: string;
}

/** Detects the content type, preferring magic bytes, then the filename, then text vs. binary. */
export function detectType(bytes: Uint8Array, filename?: string): Detected {
  const head = bytes.subarray(0, 64);
  const fileExt = filename?.includes(".") ? filename.split(".").pop()!.toLowerCase() : undefined;
  // ZIP containers (apk, docx, ...) share a signature, so let the extension decide.
  if (starts(head, [0x50, 0x4b, 0x03, 0x04])) {
    const type = fileExt && EXTENSIONS[fileExt]?.startsWith("application/") ? EXTENSIONS[fileExt]! : "application/zip";
    return { type, ext: fileExt && EXTENSIONS[fileExt] ? fileExt : "zip" };
  }
  for (const [type, ext, test] of SIGNATURES) if (test(head)) return { type, ext };
  if (fileExt && EXTENSIONS[fileExt] && fileExt !== "txt" && fileExt !== "log") {
    return { type: EXTENSIONS[fileExt]!, ext: fileExt };
  }
  if (isValidUtf8(bytes.subarray(0, safeCut(bytes)))) {
    return { type: "text/plain; charset=utf-8", ext: "txt" };
  }
  return { type: "application/octet-stream", ext: "bin" };
}

// Avoid failing UTF-8 validation just because the sample cut a multi-byte char in half.
function safeCut(bytes: Uint8Array): number {
  let end = Math.min(bytes.length, 4096);
  if (end === bytes.length) return end;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}
