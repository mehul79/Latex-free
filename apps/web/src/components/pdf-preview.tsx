"use client";

import { useEffect, useRef, useState } from "react";
import { pdfWorkerSource } from "@/lib/pdf-renderer";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export function PdfPreview({ pdfBase64 }: { pdfBase64: string }) {
  return <PdfDocument key={pdfBase64} pdfBase64={pdfBase64} />;
}

function PdfDocument({ pdfBase64 }: { pdfBase64: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewportContainer = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [displayZoom, setDisplayZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    const container = viewportContainer.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let task:
      ReturnType<(typeof import("pdfjs-dist"))["getDocument"]> | undefined;
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSource();
      const data = Uint8Array.from(atob(pdfBase64), (character) =>
        character.charCodeAt(0),
      );
      task = pdfjs.getDocument({ data });
      const loaded = await task.promise;
      if (!cancelled) setDocument(loaded);
    })().catch((reason: unknown) => {
      if (!cancelled)
        setError(
          reason instanceof Error ? reason.message : "Could not open the PDF.",
        );
    });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [pdfBase64]);

  useEffect(() => {
    if (!document || !canvas.current || (fitWidth && !availableWidth)) return;
    let cancelled = false;
    let renderTask:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
      | undefined;
    void (async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled || !canvas.current) return;
      setRendering(true);
      setError(null);
      const scale = fitWidth
        ? availableWidth / pdfPage.getViewport({ scale: 1 }).width
        : zoom;
      const viewport = pdfPage.getViewport({ scale });
      setDisplayZoom(scale);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const target = canvas.current;
      target.width = Math.ceil(viewport.width * ratio);
      target.height = Math.ceil(viewport.height * ratio);
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      const context = target.getContext("2d");
      if (!context)
        throw new Error("Your browser could not create the PDF canvas.");
      renderTask = pdfPage.render({
        canvas: target,
        canvasContext: context,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      await renderTask.promise;
    })()
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not render this page.",
          );
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, page, zoom, fitWidth, availableWidth]);

  function manualZoom(value: number) {
    setFitWidth(false);
    setZoom(Math.min(3, Math.max(0.1, value)));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-1 border-b bg-background px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={fitWidth}
            onClick={() => setFitWidth(true)}
          >
            Fit width
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous PDF page"
            disabled={!document || page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            <ChevronLeft />
          </Button>
          <span
            className="min-w-20 text-center text-xs tabular-nums"
            aria-live="polite"
          >
            {document ? `Page ${page} of ${document.numPages}` : "Loading PDF…"}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next PDF page"
            disabled={!document || page >= document.numPages}
            onClick={() => setPage((value) => value + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            disabled={displayZoom <= 0.1}
            onClick={() => manualZoom(displayZoom - 0.25)}
          >
            <ZoomOut />
          </Button>
          <button
            className="min-w-12 rounded px-1 py-2 text-xs tabular-nums hover:bg-muted"
            title="Reset zoom"
            onClick={() => manualZoom(1)}
          >
            {Math.round(displayZoom * 100)}%
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            disabled={displayZoom >= 3}
            onClick={() => manualZoom(displayZoom + 0.25)}
          >
            <ZoomIn />
          </Button>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="border-b bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          PDF preview unavailable: {error} You can still download the compiled
          PDF.
        </p>
      )}
      <div
        ref={viewportContainer}
        className="relative min-h-0 flex-1 overflow-auto bg-muted/60 p-4"
        aria-busy={!document || rendering}
      >
        {(!document || rendering) && !error && (
          <span
            role="status"
            className="sticky top-0 left-0 z-10 inline-flex items-center gap-2 rounded bg-background/95 px-3 py-2 text-xs shadow"
          >
            <Loader2 size={13} className="animate-spin" />
            Rendering PDF…
          </span>
        )}
        <canvas
          ref={canvas}
          aria-label={`PDF page ${page}`}
          role="img"
          className="mx-auto block bg-white shadow-md"
          hidden={!document || !!error}
        />
      </div>
    </div>
  );
}
