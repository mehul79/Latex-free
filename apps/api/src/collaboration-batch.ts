import * as Y from "yjs";
import { z } from "zod";
import { filePathSchema, updateFileSchema } from "@latex-free/shared";
import { cloneDocument, validateDocument } from "./collaboration-document.js";
import { ApiError } from "./document-service.js";
export const storedAiChangeSchema = z
  .object({
    fileId: z.string().min(1).max(200),
    path: filePathSchema,
    baseVersion: updateFileSchema.shape.version,
    before: updateFileSchema.shape.content,
    after: updateFileSchema.shape.content,
  })
  .strict();
export const storedAiPayloadSchema = z.object({
  changes: z
    .array(storedAiChangeSchema)
    .min(1)
    .max(10)
    .refine(
      (changes) =>
        new Set(changes.map((change) => change.fileId)).size === changes.length,
      "Duplicate proposal file",
    ),
});
export type TextBatchChange = {
  fileId: string;
  expectedVersion: number;
  content: string;
  before?: string;
  path?: string;
};
export type PreparedTextChange = TextBatchChange & {
  document: Y.Doc;
  candidate: Y.Doc;
  state: Uint8Array;
  content: string;
};
export function prepareTextBatch(
  documents: ReadonlyMap<string, Y.Doc>,
  changes: readonly TextBatchChange[],
): PreparedTextChange[] {
  if (
    !changes.length ||
    changes.length > 10 ||
    new Set(changes.map((change) => change.fileId)).size !== changes.length
  )
    throw new ApiError(400, "Invalid text batch");
  const prepared: PreparedTextChange[] = [];
  try {
    for (const change of changes) {
      updateFileSchema.parse({
        version: change.expectedVersion,
        content: change.content,
      });
      const document = documents.get(change.fileId);
      if (!document) throw new ApiError(404, "Text file not found");
      const candidate = cloneDocument(document);
      prepared.push({
        ...change,
        document,
        candidate,
        state: new Uint8Array(),
        content: change.content,
      });
      const source = candidate.getText("source");
      candidate.transact(() => {
        source.delete(0, source.length);
        source.insert(0, change.content);
      });
      Object.assign(prepared[prepared.length - 1], validateDocument(candidate));
    }
    return prepared;
  } catch (error) {
    for (const item of prepared) item.candidate.destroy();
    throw error;
  }
}
