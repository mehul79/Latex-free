import { createCompilerServer } from "./server.js";

const token = process.env.WORKER_TOKEN;
if (!token) throw new Error("Set WORKER_TOKEN before starting the compiler worker");
const host = process.env.COMPILER_HOST || "127.0.0.1";
const port = Number(process.env.COMPILER_PORT || 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid COMPILER_PORT");
const server = createCompilerServer(token);
server.listen(port, host, () => console.log(`Compiler worker listening on ${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
