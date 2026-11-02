import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { compileRequestSchema } from "@latex-free/shared";
import { Compiler, WorkerBusyError } from "./compiler.js";

const MAX_BODY = 30 * 1024 * 1024;
export function createCompilerServer(token: string, compiler = new Compiler()): Server {
  if (Buffer.byteLength(token) < 32) throw new Error("WORKER_TOKEN must contain at least 32 bytes");
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer({ requestTimeout: 85_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (request, response) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(data));
    };
    if (request.method === "GET" && request.url === "/health") return send(200, { status: "ok" });
    if (request.method !== "POST" || request.url !== "/compile") return send(404, { error: "Not found" });
    const supplied = Buffer.from(request.headers.authorization || "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: "Unauthorized" });
    if (!(request.headers["content-type"] || "").startsWith("application/json")) return send(415, { error: "Use application/json" });
    if (Number(request.headers["content-length"] || 0) > MAX_BODY) return send(413, { error: "Request is too large" });
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) { send(413, { error: "Request is too large" }); return; }
        chunks.push(chunk);
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(400, { error: "Invalid JSON" }); return; }
      const parsed = compileRequestSchema.safeParse(value);
      if (!parsed.success) return send(400, { error: "Invalid compile request", issues: parsed.error.issues });
      const result = await compiler.compile(parsed.data);
      send(200, result);
    } catch (error) {
      if (error instanceof WorkerBusyError) send(429, { error: "Compiler is busy. Try again shortly." });
      else send(500, { error: "Compiler request failed" });
    }
  });
}
