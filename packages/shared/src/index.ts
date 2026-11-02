import { z } from "zod";

export const templateIds = ["blank", "article", "resume", "report"] as const;
export type TemplateId = (typeof templateIds)[number];
export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  template: z.enum(templateIds).default("blank"),
});
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  starred: z.boolean().optional(),
});
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1_000_000;
export const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
export const MAX_PROJECT_FILES = 500;
export const filePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      path === path.trim() &&
      !path.startsWith("/") &&
      !path
        .split("/")
        .some(
          (part) =>
            part === ".." || part === "." || !part || part !== part.trim(),
        ) &&
      !/[\\:\x00-\x1f\x7f]/.test(path),
    "Use a relative file path without traversal",
  );
export function fileByteLength(file: { content: string; encoding?: string }) {
  return file.encoding === "base64"
    ? (file.content.length * 3) / 4 -
        (file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0)
    : new TextEncoder().encode(file.content).length;
}
export function pathsCollide(a: string, b: string) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export const createFileSchema = z
  .object({
    path: filePathSchema,
    content: z
      .string()
      .max(Math.ceil(MAX_FILE_BYTES / 3) * 4)
      .default(""),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    mimeType: z
      .string()
      .max(120)
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)
      .nullable()
      .optional(),
  })
  .superRefine((file, ctx) => {
    if (file.encoding === "base64") {
      const padding = file.content.endsWith("==")
        ? 2
        : file.content.endsWith("=")
          ? 1
          : 0;
      const data = file.content.slice(0, file.content.length - padding);
      if (
        file.content.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*$/.test(data) ||
        (padding === 2 && !/[AQgw]$/.test(data)) ||
        (padding === 1 && !/[AEIMQUYcgkosw048]$/.test(data))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["content"],
          message: "Invalid base64",
        });
      }
    }
    if (
      fileByteLength(file) >
      (file.encoding === "utf8" ? MAX_TEXT_BYTES : MAX_FILE_BYTES)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "File exceeds size limit",
      });
    }
  });
export const updateFileSchema = z.object({
  content: z
    .string()
    .max(MAX_TEXT_BYTES)
    .refine(
      (content) => new TextEncoder().encode(content).length <= MAX_TEXT_BYTES,
      "Text exceeds size limit",
    ),
  version: z.number().int().min(0).max(2147483646),
});
export const renameFileSchema = z.object({
  path: filePathSchema,
  version: updateFileSchema.shape.version,
});
export const deleteFileSchema = z.object({
  version: z.coerce.number().int().min(0).max(2147483646),
});
export const importProjectSchema = z
  .object({
    name: createProjectSchema.shape.name,
    files: z.array(createFileSchema).min(1).max(MAX_PROJECT_FILES),
  })
  .superRefine(({ files }, ctx) => {
    if (
      files.reduce((size, file) => size + fileByteLength(file), 0) >
      MAX_PROJECT_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["files"],
        message: "Project exceeds size limit",
      });
    }
    const paths = new Set<string>();
    for (const file of files) {
      if (paths.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["files"],
          message: "File paths collide",
        });
        break;
      }
      paths.add(file.path);
    }
    for (const path of paths) {
      const parts = path.split("/");
      parts.pop();
      while (parts.length) {
        if (paths.has(parts.join("/"))) {
          ctx.addIssue({
            code: "custom",
            path: ["files"],
            message: "File paths collide",
          });
          break;
        }
        parts.pop();
      }
    }
  });
export type ProjectFile = {
  id: string;
  path: string;
  content: string;
  version: number;
  encoding?: "utf8" | "base64";
  mimeType?: string | null;
};
export type Project = {
  id: string;
  name: string;
  template: TemplateId;
  starred: boolean;
  updatedAt: string;
  files: ProjectFile[];
  role?: "OWNER" | "EDITOR" | "VIEWER";
};
export type Template = {
  id: TemplateId;
  name: string;
  description: string;
  category: string;
  source: string;
};
export const templates: Template[] = [
  {
    id: "blank",
    name: "Blank project",
    description: "A clean page. An open possibility.",
    category: "Start fresh",
    source:
      "\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\title{Untitled document}\n\\author{Your name}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\section{Introduction}\nYour next idea starts here.\n\n\\end{document}\n",
  },
  {
    id: "article",
    name: "Academic article",
    description: "Give your next discovery a home.",
    category: "Research",
    source:
      "\\documentclass[11pt]{article}\n\\usepackage[margin=1in]{geometry}\n\\usepackage{amsmath}\n\\title{A new perspective}\n\\author{Your name}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\begin{abstract}\nA brief overview of the question, the approach, and what we discovered.\n\\end{abstract}\n\n\\section{Introduction}\nEvery discovery begins with a question.\n\n\\section{Methods}\nDescribe your approach here.\n\n\\section{Results}\nPresent your findings.\n\n\\section{Conclusion}\nWhat comes next?\n\\end{document}\n",
  },
  {
    id: "resume",
    name: "Simple resume",
    description: "Your experience, beautifully put.",
    category: "Career",
    source:
      "\\documentclass[10pt]{article}\n\\usepackage[margin=0.75in]{geometry}\n\\usepackage{hyperref}\n\\pagestyle{empty}\n\n\\begin{document}\n\\begin{center}\n{\\LARGE \\textbf{Your Name}}\\\\[6pt]\nyou@example.com $\\cdot$ Your City\n\\end{center}\n\n\\section*{Experience}\n\\textbf{Role} \\hfill 2024 -- Present\\\\\nCompany Name\n\\begin{itemize}\n\\item Describe an achievement and its impact.\n\\end{itemize}\n\n\\section*{Education}\n\\textbf{Degree} \\hfill Graduation year\\\\\nUniversity Name\n\n\\section*{Skills}\nYour skills and tools\n\\end{document}\n",
  },
  {
    id: "report",
    name: "Research report",
    description: "Make space for the bigger picture.",
    category: "Long form",
    source:
      "\\documentclass[12pt]{report}\n\\usepackage[margin=1in]{geometry}\n\\title{Research report}\n\\author{Your name}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\\tableofcontents\n\n\\chapter{Introduction}\nDescribe the problem and your objectives.\n\n\\chapter{Background}\nReview the existing work.\n\n\\chapter{Methodology}\nExplain how you approached the problem.\n\n\\chapter{Findings}\nPresent the evidence.\n\n\\chapter{Conclusion}\nSummarize your contribution and future work.\n\\end{document}\n",
  },
];
export function initialFiles(template: TemplateId) {
  return [
    {
      path: "main.tex",
      content: templates.find((item) => item.id === template)!.source,
    },
  ];
}

export const compileEngines = ["pdflatex", "xelatex", "lualatex"] as const;
export type CompileEngine = (typeof compileEngines)[number];
export const compileRequestSchema = z
  .object({
    files: z.array(createFileSchema).min(1).max(MAX_PROJECT_FILES),
    mainFile: filePathSchema.refine(
      (path) => path.toLowerCase().endsWith(".tex"),
      "Choose a TeX main file",
    ),
    engine: z.enum(compileEngines),
  })
  .superRefine((input, ctx) => {
    const validated = importProjectSchema.safeParse({
      name: "Compile",
      files: input.files,
    });
    if (!validated.success)
      for (const issue of validated.error.issues)
        ctx.addIssue({ ...issue, path: issue.path });
    if (
      !input.files.some(
        (file) => file.path === input.mainFile && file.encoding === "utf8",
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["mainFile"],
        message: "Main file must be an existing UTF-8 TeX file",
      });
  });
export type CompileRequest = z.input<typeof compileRequestSchema>;
export type CompileDiagnostic = {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
};
export type CompileResult = {
  status: "succeeded" | "failed";
  pdfBase64?: string;
  synctexBase64?: string;
  log: string;
  diagnostics: CompileDiagnostic[];
  durationMs: number;
};
export const compileResultSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  pdfBase64: z.string().max(28_000_000).optional(),
  synctexBase64: z.string().max(28_000_000).optional(),
  log: z.string().max(2_000_000),
  diagnostics: z
    .array(
      z.object({
        severity: z.enum(["error", "warning"]),
        message: z.string().max(10_000),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
      }),
    )
    .max(2000),
  durationMs: z.number().finite().nonnegative(),
});

export const memberRoleSchema = z.enum(["EDITOR", "VIEWER"]);
export const addProjectMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: memberRoleSchema,
});
export const updateProjectMemberSchema = z.object({ role: memberRoleSchema });
export const restoreFileRevisionSchema = z.object({
  expectedVersion: updateFileSchema.shape.version,
});
export const revisionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
export type ProjectMember = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: "OWNER" | "EDITOR" | "VIEWER";
};
export type FileRevisionMetadata = {
  id: string;
  version: number;
  path: string;
  createdAt: string;
  reason:
    "create" | "baseline" | "edit" | "rename" | "restore" | "collaboration";
  author: { id: string; name: string } | null;
};
export type FileRevision = FileRevisionMetadata & { content: string };

export type CollaborationBarrier = {
  type: "persistence-barrier";
  sequence: number;
};
export type CollaborationMessage =
  | { type: "persisted"; sequence: number; version: number }
  | { type: "document-status"; version: number }
  | {
      type: "identity";
      user: { id: string; name: string };
      role: "OWNER" | "EDITOR" | "VIEWER";
      version: number;
    }
  | { type: "reload-required"; reason: "membership" | "rename" | "deleted" }
  | { type: "persistence-error"; error: string };
