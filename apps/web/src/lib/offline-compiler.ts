import {
  compileRequestSchema,
  type CompileRequest,
  type CompileResult,
} from "@latex-free/shared";
import { preparePdfRenderer } from "./pdf-renderer";
import manifest from "../../public/compiler/manifest.json";

export const compilerCache = `latex-free-compiler-${manifest.version}`;
const prefix = `/compiler/${manifest.version}/`;
const total = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
const transferLimit = 160 * 1024 * 1024;

async function control(signal?: AbortSignal) {
  if (
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    !("caches" in window)
  )
    throw new Error(
      "Offline compilation needs a secure browser with Service Worker and Cache Storage support (HTTPS or localhost).",
    );
  await navigator.serviceWorker.register("/offline-compiler-sw.js", {
    scope: "/",
  });
  await navigator.serviceWorker.ready;
  if (
    navigator.serviceWorker.controller?.scriptURL.endsWith(
      "/offline-compiler-sw.js",
    )
  )
    return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Offline compiler could not control this page. Reload and try again.",
          ),
        ),
      15000,
    );
    function finish(error?: Error) {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    }
    function changed() {
      if (
        navigator.serviceWorker.controller?.scriptURL.endsWith(
          "/offline-compiler-sw.js",
        )
      )
        finish();
    }
    function aborted() {
      finish(new Error("Preparation cancelled."));
    }
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    signal?.addEventListener("abort", aborted, { once: true });
    changed();
    if (signal?.aborted) aborted();
  });
}

export async function offlineCompilerReady() {
  if (!("caches" in window) || !("serviceWorker" in navigator)) return false;
  const cache = await caches.open(compilerCache);
  const all = await Promise.all(
    manifest.assets.map((asset) => cache.match(prefix + asset.name)),
  );
  if (!all.every(Boolean)) return false;
  await control();
  await preparePdfRenderer();
  return true;
}

export async function clearOfflineCompiler() {
  await caches.delete(compilerCache);
}

export async function prepareOfflineCompiler(
  signal: AbortSignal,
  progress: (received: number, total: number) => void,
) {
  await control(signal);
  await clearOfflineCompiler();
  const cache = await caches.open(compilerCache);
  let received = 0;
  try {
    await preparePdfRenderer();
    for (const asset of manifest.assets) {
      signal.throwIfAborted();
      const response = await fetch(prefix + asset.name, {
        signal,
        cache: "no-store",
      });
      if (!response.ok || !response.body)
        throw new Error(
          "Compiler assets unavailable. The host must run npm run compiler:assets and rebuild the web app.",
        );
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          received += value.byteLength;
          if (size > asset.bytes || received > transferLimit)
            throw new Error("Compiler download exceeds the pinned size limit.");
          chunks.push(value);
          progress(received, total);
        }
      } finally {
        await reader.cancel();
      }
      if (size !== asset.bytes)
        throw new Error(`Incomplete compiler asset: ${asset.name}`);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (hash !== asset.sha256)
        throw new Error(`Compiler checksum mismatch: ${asset.name}`);
      signal.throwIfAborted();
      await cache.put(
        prefix + asset.name,
        new Response(bytes, {
          headers: {
            "Content-Type": asset.name.endsWith(".js")
              ? "application/javascript"
              : asset.name.endsWith(".wasm")
                ? "application/wasm"
                : "application/octet-stream",
          },
        }),
      );
    }
    signal.throwIfAborted();
    for (const name of await caches.keys())
      if (name.startsWith("latex-free-compiler-") && name !== compilerCache)
        await caches.delete(name);
  } catch (error) {
    await clearOfflineCompiler();
    throw error;
  }
}

export async function compileOffline(
  input: CompileRequest,
  signal: AbortSignal,
): Promise<CompileResult> {
  const validated = compileRequestSchema.parse(input);
  if (validated.engine !== "pdflatex")
    throw new Error("Browser compilation supports pdfLaTeX only.");
  if (!(await offlineCompilerReady()))
    throw new Error("Prepare the offline compiler first.");
  signal.throwIfAborted();
  const started = performance.now();
  // A fresh classic worker keeps upstream Emscripten scripts out of the Next bundler.
  const worker = new Worker(prefix + "busytex_worker.js");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Browser compilation exceeded 60 seconds.")),
      60000,
    );
    function finish(error?: Error, result?: CompileResult) {
      clearTimeout(timer);
      worker.terminate();
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(result!);
    }
    function aborted() {
      finish(new Error("Compilation cancelled."));
    }
    signal.addEventListener("abort", aborted, { once: true });
    worker.onerror = () =>
      finish(
        new Error(
          "Browser compiler failed to load. Clear its cache and prepare it again.",
        ),
      );
    let recentLog = "";
    let initialized = false;
    worker.onmessage = ({ data }) => {
      if (data.print)
        recentLog = (recentLog + "\n" + String(data.print)).slice(-60000);
      if (data.exception) {
        const log = (String(data.exception) + "\n" + recentLog).slice(-60000);
        if (initialized)
          finish(undefined, {
            status: "failed",
            log,
            diagnostics: [
              {
                severity: "error",
                message:
                  "Browser pdfLaTeX failed. Check the log and required packages.",
              },
            ],
            durationMs: performance.now() - started,
          });
        else finish(new Error(log));
        return;
      }
      if (data.initialized) {
        initialized = true;
        worker.postMessage({
          files: validated.files.map((file) => ({
            path: file.path,
            contents:
              file.encoding === "base64"
                ? Uint8Array.from(atob(file.content), (ch) => ch.charCodeAt(0))
                : file.content,
          })),
          main_tex_path: validated.mainFile,
          bibtex: null,
          // Info streams TeX diagnostics even when upstream throws a fatal-exit sentinel.
          verbose: "info",
          driver: "pdftex_bibtex8",
          data_packages_js: [location.origin + prefix + "texlive-basic.js"],
        });
      } else if ("exit_code" in data) {
        if (
          typeof data.log !== "string" ||
          data.log.length > 2_000_000 ||
          (data.pdf &&
            (!(data.pdf instanceof Uint8Array) ||
              data.pdf.byteLength > 20 * 1024 * 1024))
        ) {
          finish(new Error("Browser compiler output exceeded its limits."));
          return;
        }
        let pdfBase64: string | undefined;
        if (data.pdf?.byteLength && data.exit_code === 0) {
          const chunks: string[] = [];
          for (let index = 0; index < data.pdf.length; index += 8192)
            chunks.push(
              String.fromCharCode(...data.pdf.subarray(index, index + 8192)),
            );
          pdfBase64 = btoa(chunks.join(""));
        }
        const succeeded = !!pdfBase64;
        finish(undefined, {
          status: succeeded ? "succeeded" : "failed",
          pdfBase64,
          log: data.log,
          diagnostics: succeeded
            ? []
            : [
                {
                  severity: "error",
                  message:
                    "Browser pdfLaTeX failed. Check the log; packages outside the basic pack are unavailable offline.",
                },
              ],
          durationMs: performance.now() - started,
        });
      }
    };
    worker.postMessage({
      busytex_js: location.origin + prefix + "busytex.js",
      busytex_wasm: location.origin + prefix + "busytex.wasm",
      data_packages_js: [location.origin + prefix + "texlive-basic.js"],
      preload_data_packages_js: [location.origin + prefix + "texlive-basic.js"],
      texmf_local: [],
      preload: true,
    });
  });
}
