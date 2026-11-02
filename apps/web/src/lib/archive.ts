import { Unzip, UnzipInflate, zipSync } from "fflate";
import {
  importProjectSchema,
  filePathSchema,
  MAX_FILE_BYTES,
  MAX_TEXT_BYTES,
  MAX_PROJECT_BYTES,
  MAX_PROJECT_FILES,
  type Project,
} from "@latex-free/shared";
import type { ImportFile } from "@/stores/workspace";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_ARCHIVE_BYTES = Math.ceil(MAX_PROJECT_BYTES * 1.5) + 1024 * 1024;
export type ImportedProject = { name: string; files: ImportFile[] };
const binaryTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  ico: "image/x-icon",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  eps: "application/postscript",
};
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function bytes(file: ImportFile) {
  if (file.encoding !== "base64") return encoder.encode(file.content);
  return Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));
}
function validate(input: unknown): ImportedProject {
  const result = importProjectSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      result.error.issues[0]?.message ?? "Invalid project archive",
    );
  return result.data;
}
export function exportProjectJson(project: Project): string {
  validate(project);
  return JSON.stringify(project, null, 2);
}
export function exportProjectZip(project: Project): Uint8Array {
  const input = validate(project);
  const entries: Record<string, Uint8Array> = Object.create(null);
  for (const file of input.files) entries[file.path] = bytes(file);
  return zipSync(entries, { level: 6 });
}
function safePath(path: string, directory = false) {
  const normalized = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!filePathSchema.safeParse(normalized).success)
    throw new Error(`Unsafe archive path: ${path}`);
}
// Validate every central-directory entry before inflating anything. Streaming limits
// below also count actual output, since ZIP size declarations are untrusted.
function inspectZip(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (
    let at = data.length - 22;
    at >= Math.max(0, data.length - 65557);
    at--
  ) {
    if (
      view.getUint32(at, true) === 0x06054b50 &&
      at + 22 + view.getUint16(at + 20, true) === data.length
    ) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("Invalid ZIP directory");
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new Error("Multi-part ZIP archives are unsupported");
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    start = view.getUint32(end + 16, true);
  if (
    count === 65535 ||
    start === 0xffffffff ||
    size === 0xffffffff ||
    count !== view.getUint16(end + 8, true) ||
    start + size !== end ||
    count > MAX_PROJECT_FILES * 2
  )
    throw new Error("Unsupported or oversized ZIP directory");
  const entries = new Map<string, { size: number; directory: boolean }>();
  let cursor = start,
    total = 0,
    files = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error("Invalid ZIP entry");
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true),
      length = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true),
      extraLength = view.getUint16(cursor + 30, true),
      commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new Error("Invalid ZIP entry length");
    const path = decoder.decode(
      data.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    const directory = path.endsWith("/");
    safePath(path, directory);
    if (flags & 1 || (method !== 0 && method !== 8))
      throw new Error("Encrypted or unsupported ZIP compression");
    if (entries.has(path)) throw new Error("Duplicate ZIP paths");
    if (((view.getUint32(cursor + 38, true) >>> 16) & 0xf000) === 0xa000)
      throw new Error("ZIP symbolic links are unsupported");
    if (
      length > MAX_FILE_BYTES ||
      (total += length) > MAX_PROJECT_BYTES ||
      (!directory && ++files > MAX_PROJECT_FILES)
    )
      throw new Error("ZIP exceeds project size limits");
    entries.set(path, { size: length, directory });
    cursor = next;
  }
  if (cursor !== end) throw new Error("Invalid ZIP directory size");
  return entries;
}
function readZip(data: Uint8Array): ImportFile[] {
  const entries = inspectZip(data);
  const files: ImportFile[] = [],
    seen = new Set<string>();
  let total = 0;
  const unzip = new Unzip((file) => {
    safePath(file.name, file.name.endsWith("/"));
    const expected = entries.get(file.name);
    if (!expected || seen.has(file.name))
      throw new Error("ZIP headers do not match its directory");
    seen.add(file.name);
    if (expected.directory) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length;
      total += chunk.length;
      if (
        size > MAX_FILE_BYTES ||
        total > MAX_PROJECT_BYTES ||
        size > expected.size
      ) {
        file.terminate();
        throw new Error("ZIP exceeds project size limits");
      }
      chunks.push(chunk);
      if (!final) return;
      if (size !== expected.size)
        throw new Error("ZIP file size does not match its directory");
      const content = new Uint8Array(size);
      let offset = 0;
      for (const part of chunks) {
        content.set(part, offset);
        offset += part.length;
      }
      const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
      const mimeType = binaryTypes[extension];
      let text: string | undefined;
      if (!mimeType) {
        try {
          const decoded = decoder.decode(content);
          if (!decoded.includes("\0")) text = decoded;
        } catch {
          /* Binary content is preserved verbatim. */
        }
      }
      if (text !== undefined) {
        if (size > MAX_TEXT_BYTES)
          throw new Error("Text file exceeds size limit");
        files.push({ path: file.name, content: text, encoding: "utf8" });
      } else
        files.push({
          path: file.name,
          content: base64(content),
          encoding: "base64",
          mimeType: mimeType ?? "application/octet-stream",
        });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small compressed chunks bound allocations even if declared sizes are forged.
  for (let at = 0; at < data.length; at += 1024)
    unzip.push(data.subarray(at, at + 1024), at + 1024 >= data.length);
  if (
    seen.size !== entries.size ||
    files.length !== [...entries.values()].filter((e) => !e.directory).length
  )
    throw new Error("Incomplete ZIP archive");
  return files;
}
export async function importProjectArchive(file: {
  name: string;
  size?: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<ImportedProject> {
  if (file.size !== undefined && file.size > MAX_ARCHIVE_BYTES)
    throw new Error("Archive exceeds size limit");
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length > MAX_ARCHIVE_BYTES)
    throw new Error("Archive exceeds size limit");
  if (file.name.toLowerCase().endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(data));
    } catch {
      throw new Error("Invalid JSON project backup");
    }
    return validate(parsed);
  }
  if (!file.name.toLowerCase().endsWith(".zip"))
    throw new Error("Choose a ZIP archive or JSON project backup");
  return validate({
    name: file.name.replace(/\.zip$/i, "").slice(0, 100) || "Imported project",
    files: readZip(data),
  });
}
// Kept separate so asset uploads and archive imports use the same lossless encoding.
export async function encodeAsset(file: {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<ImportFile> {
  safePath(file.name);
  if (file.size > MAX_FILE_BYTES) throw new Error("Asset exceeds size limit");
  const content = new Uint8Array(await file.arrayBuffer());
  if (content.length > MAX_FILE_BYTES)
    throw new Error("Asset exceeds size limit");
  return {
    path: file.name,
    content: base64(content),
    encoding: "base64",
    mimeType: file.type || null,
  };
}
