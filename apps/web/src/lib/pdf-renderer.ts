let workerBlob: string | undefined;
let preparation: Promise<void> | undefined;
export function pdfWorkerSource() {
  return (
    workerBlob ??
    new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString()
  );
}
// The current open editor retains its renderer and worker in memory. No app-shell caching.
export function preparePdfRenderer() {
  return (preparation ??= (async () => {
    await import("pdfjs-dist");
    const response = await fetch(pdfWorkerSource());
    if (!response.ok)
      throw new Error(
        "PDF renderer could not be prepared. Try again while connected.",
      );
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 5 * 1024 * 1024)
      throw new Error("PDF renderer exceeds its size limit.");
    workerBlob = URL.createObjectURL(
      new Blob([bytes], { type: "application/javascript" }),
    );
  })().catch((error) => {
    preparation = undefined;
    throw error;
  }));
}
