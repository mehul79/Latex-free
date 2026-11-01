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
export const filePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.split("/").some((part) => part === ".." || part === "." || !part) &&
      !/[\\\x00-\x1f]/.test(path),
    "Use a relative file path without traversal",
  );
export const createFileSchema = z.object({
  path: filePathSchema,
  content: z.string().max(1_000_000).default(""),
});
export const updateFileSchema = z.object({
  content: z.string().max(1_000_000),
  version: z.number().int().nonnegative(),
});
export type ProjectFile = {
  id: string;
  path: string;
  content: string;
  version: number;
};
export type Project = {
  id: string;
  name: string;
  template: TemplateId;
  starred: boolean;
  updatedAt: string;
  files: ProjectFile[];
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
