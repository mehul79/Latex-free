import { describe, expect, it } from "vitest";
import { zipSync, strToU8, unzipSync } from "fflate";
import {
  MAX_FILE_BYTES,
  MAX_PROJECT_FILES,
  type Project,
} from "@latex-free/shared";
import {
  exportProjectJson,
  exportProjectZip,
  importProjectArchive,
} from "../src/lib/archive";
function archive(data: Uint8Array, name = "Imported.zip") {
  return {
    name,
    size: data.length,
    arrayBuffer: async () => Uint8Array.from(data).buffer,
  };
}
const project: Project = {
  id: "p",
  name: "Paper",
  template: "article",
  starred: false,
  updatedAt: new Date().toISOString(),
  files: [
    {
      id: "tex",
      path: "chapters/intro.tex",
      content: "\\section{Résumé} Ω",
      version: 0,
    },
    {
      id: "img",
      path: "images/plot.png",
      content: "iVBORw0KGgoAAQID",
      encoding: "base64",
      mimeType: "image/png",
      version: 0,
    },
  ],
};
describe("project archives", () => {
  it("round trips nested Unicode source and binary image bytes through ZIP", async () => {
    const zipped = exportProjectZip(project);
    expect(unzipSync(zipped)["images/plot.png"]).toEqual(
      Uint8Array.from(atob(project.files[1].content), (c) => c.charCodeAt(0)),
    );
    const restored = await importProjectArchive(archive(zipped, "Paper.zip"));
    expect(restored.name).toBe("Paper");
    expect(restored.files).toEqual([
      {
        path: "chapters/intro.tex",
        content: project.files[0].content,
        encoding: "utf8",
      },
      {
        path: "images/plot.png",
        content: project.files[1].content,
        encoding: "base64",
        mimeType: "image/png",
      },
    ]);
  });
  it("imports the original JSON backup format with missing encoding fields", async () => {
    const restored = await importProjectArchive(
      archive(strToU8(exportProjectJson(project)), "backup.json"),
    );
    expect(restored.name).toBe("Paper");
    expect(restored.files[0].encoding).toBe("utf8");
    expect(restored.files[1].content).toBe(project.files[1].content);
  });
  it.each([
    "../evil.tex",
    "/absolute.tex",
    "folder/../../evil.tex",
    "hidden/../",
    "C:/evil.tex",
    "folder\\evil.tex",
  ])(
    "rejects traversal or unsafe path %s before ignoring any entries",
    async (path) => {
      const data = zipSync({
        "main.tex": strToU8("safe"),
        [path]: new Uint8Array(),
      });
      await expect(importProjectArchive(archive(data))).rejects.toThrow(
        "Unsafe archive path",
      );
    },
  );
  it("rejects filename/directory collisions", async () => {
    await expect(
      importProjectArchive(
        archive(
          zipSync({ chapter: strToU8("a"), "chapter/main.tex": strToU8("b") }),
        ),
      ),
    ).rejects.toThrow("collide");
  });
  it("bounds file count before decompression", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_PROJECT_FILES; i++)
      files[`file${i}.tex`] = new Uint8Array();
    await expect(importProjectArchive(archive(zipSync(files)))).rejects.toThrow(
      "size limits",
    );
  });
  it("bounds decoded file size despite a tiny compressed archive", async () => {
    const zipped = zipSync({ "bomb.bin": new Uint8Array(MAX_FILE_BYTES + 1) });
    expect(zipped.length).toBeLessThan(10000);
    await expect(importProjectArchive(archive(zipped))).rejects.toThrow(
      "size limits",
    );
  });
  it("bounds actual inflation when central and local headers lie about size", async () => {
    const zipped = zipSync({ "bomb.bin": new Uint8Array(MAX_FILE_BYTES) });
    const view = new DataView(
      zipped.buffer,
      zipped.byteOffset,
      zipped.byteLength,
    );
    for (let at = 0; at <= zipped.length - 46; at++)
      if (view.getUint32(at, true) === 0x02014b50)
        view.setUint32(at + 24, 1, true);
    view.setUint32(22, 1, true);
    await expect(importProjectArchive(archive(zipped))).rejects.toThrow(
      "size limits",
    );
  });
  it("bounds total decoded project bytes", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++)
      files[`asset${i}.bin`] = new Uint8Array(MAX_FILE_BYTES);
    await expect(importProjectArchive(archive(zipSync(files)))).rejects.toThrow(
      "size limits",
    );
  });
  it("rejects corrupt ZIP and JSON imports", async () => {
    await expect(
      importProjectArchive(archive(new Uint8Array([80, 75]))),
    ).rejects.toThrow("ZIP");
    await expect(
      importProjectArchive(archive(strToU8("{bad}"), "project.json")),
    ).rejects.toThrow("JSON");
    await expect(
      importProjectArchive(
        archive(
          strToU8(
            JSON.stringify({
              name: "Invalid",
              files: [{ path: "main.tex", content: "!", encoding: "base64" }],
            }),
          ),
          "project.json",
        ),
      ),
    ).rejects.toThrow("base64");
  });
});
