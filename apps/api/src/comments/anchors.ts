import * as Y from "yjs";
import { z } from "zod";
import { ApiError } from "../document-service.js";

const relativePosition = z
  .string()
  .min(4)
  .max(2732)
  .refine((value) => {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      )
    )
      return false;
    const bytes = Buffer.from(value, "base64");
    return bytes.length <= 2048 && bytes.toString("base64") === value;
  }, "Invalid relative position");
export const anchorSchema = z
  .object({ start: relativePosition, end: relativePosition })
  .strict();
export type CommentAnchor = z.infer<typeof anchorSchema>;
export type AnchorStatus = "anchored" | "detached" | "file";

/** Decode only Yjs relative positions against the committed source state. */
export function anchorStatus(
  file: { yState: Uint8Array | null; content: string },
  raw: unknown,
  strict = false,
): AnchorStatus {
  if (raw === null || raw === undefined) return "file";
  const doc = new Y.Doc();
  try {
    const anchor = anchorSchema.parse(raw);
    if (!file.yState || file.yState.byteLength > 5 * 1024 * 1024)
      throw new Error("Missing committed state");
    const source = doc.getText("source");
    Y.applyUpdate(doc, file.yState);
    if (source.toString() !== file.content)
      throw new Error("Inconsistent source state");
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(anchor.start, "base64")),
      doc,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(anchor.end, "base64")),
      doc,
    );
    if (
      !start ||
      !end ||
      start.type !== source ||
      end.type !== source ||
      start.index < 0 ||
      start.index >= end.index ||
      end.index > source.length
    )
      throw new Error("Anchor is no longer a source range");
    return "anchored";
  } catch {
    if (strict)
      throw new ApiError(
        400,
        "Selection is not in the persisted source. Wait for sync and select the text again.",
      );
    return "detached";
  } finally {
    doc.destroy();
  }
}
