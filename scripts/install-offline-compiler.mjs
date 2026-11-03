import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  rename,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("./offline-compiler-manifest.json", import.meta.url)),
);
const destination = resolve(root, "apps/web/public/compiler", manifest.version);
await mkdir(destination, { recursive: true });
function valid(data, asset) {
  return (
    data.length === asset.bytes &&
    createHash("sha256").update(data).digest("hex") === asset.sha256
  );
}
for (const asset of manifest.assets) {
  const target = resolve(destination, asset.name);
  if (
    await readFile(target)
      .then((data) => valid(data, asset))
      .catch(() => false)
  )
    continue;
  const temp = target + ".partial";
  try {
    console.log(`Installing ${asset.name} (${asset.bytes} bytes)`);
    if (process.env.OFFLINE_COMPILER_ASSET_DIR) {
      await copyFile(
        resolve(process.env.OFFLINE_COMPILER_ASSET_DIR, asset.name),
        temp,
      );
    } else {
      // curl uses the inherited proxy and CA configuration; TLS verification stays enabled.
      const { spawn } = await import("node:child_process");
      const { pipeline } = await import("node:stream/promises");
      const { createWriteStream } = await import("node:fs");
      const download = spawn(
        "curl",
        [
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--max-time",
          "600",
          manifest.release + asset.name,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const completion = new Promise((resolve, reject) => {
        download.on("error", reject);
        download.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`Compiler download failed (curl ${code})`)),
        );
      });
      let bytes = 0;
      await Promise.all([
        completion,
        pipeline(
          download.stdout,
          async function* (source) {
            for await (const chunk of source) {
              bytes += chunk.length;
              if (bytes > asset.bytes)
                throw new Error("Asset exceeds pinned size");
              yield chunk;
            }
          },
          createWriteStream(temp),
        ).catch((error) => {
          download.kill();
          throw error;
        }),
      ]);
    }
    if (!valid(await readFile(temp), asset))
      throw new Error(`Checksum mismatch: ${asset.name}`);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}
await writeFile(
  resolve(root, "apps/web/public/compiler/manifest.json"),
  JSON.stringify(manifest),
);
console.log("Offline compiler assets verified.");
