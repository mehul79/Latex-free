import type { File } from "@prisma/client";
import type { ProjectService } from "../project-service.js";
import type { McpDomain } from "./contracts.js";
import type { McpCompileService } from "./compile-service.js";

const publicFile = ({ id, path, content, version, encoding }: File) => ({
  id,
  path,
  content,
  version,
  encoding,
});
export function createMcpDomain(
  projects: ProjectService,
  compiler: McpCompileService,
): McpDomain {
  return {
    role: (a, p) => projects.role(a, p),
    listProjects: (a, ps) => projects.listProjects(a, ps),
    listFiles: (a, p) => projects.listFiles(a, p),
    readFile: async (a, p, f) => publicFile(await projects.readFile(a, p, f)),
    createFile: async (a, p, input) =>
      publicFile(await projects.createFile(a, p, input)),
    writeFile: async (a, p, f, v, text) =>
      publicFile(await projects.writeFile(a, p, f, v, text)),
    editFile: async (a, p, f, input) =>
      publicFile(await projects.editFile(a, p, f, input)),
    deleteFile: (a, p, f, v) => projects.deleteFile(a, p, f, v),
    shareProject: (a, p, input) => projects.shareProject(a, p, input),
    compile: (a, p, input) => compiler.compile(a, p, input),
    getCompileErrors: (a, p, run) => compiler.getCompileErrors(a, p, run),
  };
}
