"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CompileEngine, CompileResult, Project } from "@latex-free/shared";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Play,
} from "lucide-react";
import {
  clearOfflineCompiler,
  compileOffline,
  offlineCompilerReady,
  prepareOfflineCompiler,
} from "@/lib/offline-compiler";
import { api } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";
import { DynamicButton } from "@/components/ui/dynamic-button";
import { Button } from "@/components/ui/button";
import { PdfPreview } from "@/components/pdf-preview";

type CompilerConfig = {
  compilerEnabled: boolean;
  localCompileEnabled: boolean;
};
type Output = { result: CompileResult; snapshot: string };

function download(name: string, content: string, mime: string, base64 = false) {
  const data = base64
    ? Uint8Array.from(atob(content), (character) => character.charCodeAt(0))
    : content;
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CompilePanel({
  project,
  onNavigateDiagnostic,
}: {
  project: Project;
  onNavigateDiagnostic?: (path: string, line?: number) => void;
}) {
  const mode = useWorkspace((state) => state.mode);
  const [source, setSource] = useState<"server" | "browser">("server");
  const [prepared, setPrepared] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [preparationFailed, setPreparationFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const preparation = useRef<AbortController | null>(null);
  const [config, setConfig] = useState<CompilerConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const texFiles = project.files.filter(
    (file) => file.path.endsWith(".tex") && file.encoding !== "base64",
  );
  const [entry, setEntry] = useState(
    () =>
      texFiles.find((file) => file.path === "main.tex")?.path ??
      texFiles[0]?.path ??
      "",
  );
  const mainFile = texFiles.some((file) => file.path === entry)
    ? entry
    : (texFiles[0]?.path ?? "");
  const [engine, setEngine] = useState<CompileEngine>("pdflatex");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<Output | null>(null);
  const [pdf, setPdf] = useState<Output | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const snapshot = useMemo(
    () =>
      JSON.stringify({
        files: project.files.map(({ path, content, encoding }) => ({
          path,
          content,
          encoding: encoding ?? "utf8",
        })),
        mainFile,
        engine: source === "browser" ? "pdflatex" : engine,
        source,
      }),
    [project.files, mainFile, engine, source],
  );

  useEffect(() => {
    void offlineCompilerReady()
      .then(setPrepared)
      .catch(() => setPrepared(false));
    const controller = new AbortController();
    void api<CompilerConfig>("/config", { signal: controller.signal })
      .then(setConfig)
      .catch(() => {
        if (!controller.signal.aborted) setConfigError(true);
      });
    return () => {
      controller.abort();
      request.current?.abort();
      preparation.current?.abort();
    };
  }, []);

  const allowed =
    source === "browser"
      ? prepared
      : !!config?.compilerEnabled &&
        (mode === "account" || !!config.localCompileEnabled);

  async function prepare() {
    const controller = new AbortController();
    preparation.current = controller;
    setPreparing(true);
    setPreparationFailed(false);
    setRequestError(null);
    setProgress(0);
    try {
      await prepareOfflineCompiler(controller.signal, (received, total) =>
        setProgress(Math.round((received / total) * 100)),
      );
      if (!controller.signal.aborted) setPrepared(true);
    } catch (error) {
      setPrepared(false);
      if (!controller.signal.aborted) {
        setPreparationFailed(true);
        setRequestError(
          error instanceof Error
            ? error.message
            : "Compiler preparation failed.",
        );
      }
    } finally {
      setPreparing(false);
    }
  }
  const stale = !!pdf && pdf.snapshot !== snapshot;
  const previous =
    !!pdf && (output?.result.status === "failed" || !!requestError);
  const filename = project.name.replace(/[^a-z0-9_-]/gi, "-") || "document";

  async function compile() {
    if (busy || !allowed || !mainFile) return;
    const submitted = snapshot;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setRequestError(null);
    try {
      const result =
        source === "browser"
          ? await compileOffline(JSON.parse(submitted), controller.signal)
          : await api<CompileResult>("/compile", {
              method: "POST",
              body: submitted,
              signal: controller.signal,
            });
      if (controller.signal.aborted) return;
      const next = { result, snapshot: submitted };
      setOutput(next);
      if (result.status === "succeeded" && result.pdfBase64) setPdf(next);
      else if (result.status === "succeeded")
        setRequestError("The compiler returned no PDF. Try compiling again.");
    } catch (reason) {
      if (!controller.signal.aborted)
        setRequestError(
          reason instanceof Error
            ? reason.message
            : "Compilation could not be started. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-background px-3 py-2">
        <span className="preview-label">
          <FileText size={14} /> PDF preview
        </span>
        <Button
          size="sm"
          disabled={busy || !allowed || !mainFile}
          onClick={() => void compile()}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Play size={14} />}
          {busy ? "Compiling…" : "Compile"}
        </Button>
        {busy && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              request.current?.abort();
              setBusy(false);
            }}
          >
            Cancel compile
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-b bg-background px-3 py-2 text-xs">
        <label className="flex items-center gap-2">
          Compiler
          <select
            aria-label="Compiler source"
            className="rounded-md border bg-background p-1.5"
            value={source}
            disabled={busy || preparing}
            onChange={(event) =>
              setSource(event.target.value as "server" | "browser")
            }
          >
            <option value="server">Server</option>
            <option value="browser">Browser (offline pdfLaTeX)</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-1 items-center gap-2">
          Main file
          <select
            aria-label="Main TeX file"
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-xs"
            value={mainFile}
            onChange={(event) => setEntry(event.target.value)}
            disabled={busy || !texFiles.length}
          >
            {!texFiles.length && <option value="">No .tex files</option>}
            {texFiles.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Engine
          <select
            aria-label="LaTeX engine"
            className="rounded-md border bg-background px-2 py-1.5 text-xs"
            value={source === "browser" ? "pdflatex" : engine}
            onChange={(event) => setEngine(event.target.value as CompileEngine)}
            disabled={busy || source === "browser"}
          >
            <option value="pdflatex">pdfLaTeX</option>
            <option value="xelatex">XeLaTeX</option>
            <option value="lualatex">LuaLaTeX</option>
          </select>
        </label>
      </div>
      {source === "browser" && (
        <div className="border-b px-3 py-2 text-xs space-y-2">
          <p>
            Browser pdfLaTeX uses a basic TeX Live pack, including geometry,
            hyperref, amsmath and BibTeX. Extra packages, XeLaTeX, LuaLaTeX and
            Biber are unavailable; there is no network fallback. Keep this
            editor open for offline use. Account sign-in and app reload still
            need a connection.
          </p>
          <p>
            <a
              className="underline"
              href="/compiler/NOTICE.txt"
              target="_blank"
              rel="noreferrer"
            >
              Compiler licenses and corresponding source
            </a>
          </p>
          <DynamicButton
            size="sm"
            variant="outline"
            disabled={preparing || prepared}
            aria-busy={preparing}
            stateKey={
              prepared
                ? "ready"
                : preparing
                  ? "preparing"
                  : preparationFailed
                    ? "failed"
                    : "idle"
            }
            icon={
              prepared ? (
                <CheckCircle2 size={14} />
              ) : preparing ? (
                <Loader2 size={14} className="motion-safe:animate-spin" />
              ) : (
                <Download size={14} />
              )
            }
            onClick={() => void prepare()}
          >
            {prepared
              ? "Offline compiler ready"
              : preparing
                ? `Preparing compiler ${progress}%`
                : preparationFailed
                  ? "Retry preparation"
                  : "Prepare offline compiler (~137 MB)"}
          </DynamicButton>
          {prepared ? (
            <>
              <p role="status">
                Offline compiler ready · stored in this browser
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void clearOfflineCompiler().then(() => {
                    setPrepared(false);
                    setPreparationFailed(false);
                  });
                }}
              >
                Clear compiler cache
              </Button>
            </>
          ) : preparing ? (
            <>
              <p role="status">Preparing offline compiler… {progress}%</p>
              <progress
                aria-label="Compiler download progress"
                value={progress}
                max={100}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => preparation.current?.abort()}
              >
                Cancel preparation
              </Button>
            </>
          ) : null}
        </div>
      )}
      {source === "server" && !allowed && (
        <p
          className="border-b bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground"
          role="status"
        >
          {configError
            ? "Compiler configuration could not be loaded. Reload the page to try again."
            : !config
              ? "Checking compiler availability…"
              : !config.compilerEnabled
                ? "The LaTeX compiler is not connected. Configure the sandboxed compiler service to generate PDFs."
                : "Sign in to compile your project. Local compilation is available only when enabled by the development server."}
        </p>
      )}
      <div className="border-b px-3 py-2 text-xs" aria-live="polite">
        {requestError ? (
          <p role="alert" className="flex gap-2 text-destructive">
            <AlertCircle size={14} className="shrink-0" />
            {requestError}
          </p>
        ) : busy ? (
          <p className="text-muted-foreground">
            Compiling a snapshot of your current files…
          </p>
        ) : output ? (
          <p
            className={
              output.result.status === "failed"
                ? "flex items-center gap-2 text-destructive"
                : "flex items-center gap-2 text-muted-foreground"
            }
          >
            {output.result.status === "failed" ? (
              <AlertCircle size={14} />
            ) : (
              <CheckCircle2 size={14} />
            )}
            {output.result.status === "failed"
              ? "Compilation failed"
              : "Compilation complete"}{" "}
            · {(output.result.durationMs / 1000).toFixed(1)}s
          </p>
        ) : (
          <p className="text-muted-foreground">
            Compile your current files to generate a PDF.
          </p>
        )}
        {pdf && (previous || stale) && (
          <p className="mt-1 text-amber-700">
            {previous
              ? "Showing the previous successful PDF."
              : "Source or compile settings changed. Recompile to update this PDF."}
            {previous && stale ? " It may be out of date." : ""}
          </p>
        )}
      </div>
      {pdf?.result.pdfBase64 ? (
        <PdfPreview pdfBase64={pdf.result.pdfBase64} />
      ) : (
        <div className="flex min-h-32 flex-1 flex-col items-center justify-center gap-3 bg-muted/25 p-8 text-center text-muted-foreground">
          <FileText size={36} strokeWidth={1} />
          <p className="font-display text-2xl text-foreground">
            Your words, beautifully set.
          </p>
          <p className="max-w-64 text-xs leading-relaxed">
            {busy
              ? "TeX Live is building your document."
              : "Choose your main file and compile to see your document here."}
          </p>
        </div>
      )}
      {(pdf || output) && (
        <div className="flex flex-wrap gap-1 border-t bg-background px-2 py-1">
          {pdf?.result.pdfBase64 && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                download(
                  `${filename}.pdf`,
                  pdf.result.pdfBase64!,
                  "application/pdf",
                  true,
                )
              }
            >
              <Download size={12} />
              PDF
            </Button>
          )}
          {output && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                download(
                  `${filename}.log`,
                  output.result.log,
                  "text/plain;charset=utf-8",
                )
              }
            >
              <Download size={12} />
              Log
            </Button>
          )}
          {pdf?.result.synctexBase64 && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                download(
                  `${filename}.synctex.gz`,
                  pdf.result.synctexBase64!,
                  "application/gzip",
                  true,
                )
              }
            >
              <Download size={12} />
              SyncTeX
            </Button>
          )}
        </div>
      )}
      {output && (
        <details
          className="shrink-0 border-t bg-background"
          open={output.result.status === "failed"}
        >
          <summary className="cursor-pointer px-4 py-2 text-xs font-medium">
            Compile log · {output.result.diagnostics.length} diagnostics
            {output.snapshot !== snapshot ? " · previous snapshot" : ""}
          </summary>
          <div className="max-h-52 overflow-auto border-t">
            {!!output.result.diagnostics.length && (
              <ul className="divide-y text-xs">
                {output.result.diagnostics.map((diagnostic, index) => (
                  <li key={index}>
                    <button
                      className="w-full px-4 py-2 text-left enabled:hover:bg-muted disabled:cursor-default"
                      disabled={
                        !diagnostic.file ||
                        !onNavigateDiagnostic ||
                        !project.files.some(
                          (file) => file.path === diagnostic.file,
                        )
                      }
                      onClick={() =>
                        diagnostic.file &&
                        onNavigateDiagnostic?.(diagnostic.file, diagnostic.line)
                      }
                    >
                      <span
                        className={
                          diagnostic.severity === "error"
                            ? "font-medium text-destructive"
                            : "font-medium text-amber-700"
                        }
                      >
                        {diagnostic.severity === "error" ? "Error" : "Warning"}
                      </span>
                      {diagnostic.file && (
                        <span className="ml-2 text-muted-foreground">
                          {diagnostic.file}
                          {diagnostic.line ? `:${diagnostic.line}` : ""}
                        </span>
                      )}
                      <span className="mt-1 block break-words">
                        {diagnostic.message}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-muted/40 p-4 font-mono text-[11px] leading-relaxed">
              {output.result.log.slice(-60000) ||
                "No compiler log was returned."}
            </pre>
          </div>
        </details>
      )}
    </div>
  );
}
