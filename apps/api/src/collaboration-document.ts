import * as Y from "yjs";
import { MAX_TEXT_BYTES } from "@latex-free/shared";
import { ApiError } from "./document-service.js";
export const MAX_Y_STATE_BYTES = 5 * 1024 * 1024;
export const MAX_Y_UPDATE_BYTES = 8 * 1024 * 1024;
export function documentKey(projectId: string, fileId: string) {
  return `${projectId}:${fileId}`;
}
export function parseDocumentKey(key: string) {
  const match = /^([a-zA-Z0-9_-]{1,100}):([a-zA-Z0-9_-]{1,100})$/.exec(key);
  if (!match) throw new ApiError(400, "Invalid document key");
  return { projectId: match[1], fileId: match[2] };
}
export function validateDocument(doc: Y.Doc) {
  const source = doc.getText("source");
  if (
    source._map.size !== 0 ||
    doc.store.pendingStructs !== null ||
    doc.store.pendingDs !== null ||
    doc.share.size !== 1 ||
    [...doc.share.keys()][0] !== "source" ||
    source
      .toDelta()
      .some(
        (part: { insert: unknown; attributes?: Record<string, unknown> }) =>
          typeof part.insert !== "string" ||
          (part.attributes && Object.keys(part.attributes).length),
      )
  )
    throw new ApiError(400, "Only plain source text is allowed");
  const content = source.toString();
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES)
    throw new ApiError(413, "Text exceeds size limit");
  const state = Y.encodeStateAsUpdate(doc);
  if (state.byteLength > MAX_Y_STATE_BYTES)
    throw new ApiError(413, "Collaborative state exceeds size limit");
  return { content, state };
}
export function cloneDocument(doc: Y.Doc) {
  const copy = new Y.Doc();
  copy.getText("source");
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}
export function equalBytes(a: Uint8Array, b: Uint8Array) {
  return (
    a.byteLength === b.byteLength &&
    a.every((value, index) => value === b[index])
  );
}
