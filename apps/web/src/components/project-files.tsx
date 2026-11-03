"use client";
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import type { ProjectFile } from "@latex-free/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Props = {
  files: ProjectFile[];
  selected?: string;
  dirty: Record<string, boolean>;
  readOnly: boolean;
  onSelect: (id: string) => void;
  onAction: (file: ProjectFile, kind: "rename" | "delete") => void;
};
export function ProjectFiles(props: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  function render(prefix: string, depth: number): React.ReactNode {
    const entries = new Map<string, ProjectFile | null>();
    for (const file of props.files) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length);
      const name = rest.split("/")[0];
      entries.set(name, rest.includes("/") ? null : file);
    }
    return [...entries]
      .sort(
        ([a, af], [b, bf]) =>
          Number(Boolean(af)) - Number(Boolean(bf)) || a.localeCompare(b),
      )
      .map(([name, file]) => {
        const key = prefix + name;
        return file ? (
          <div
            className={cn(
              "file-tree-row",
              props.selected === file.id && "active",
            )}
            key={file.id}
          >
            <button
              className="file-item"
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => props.onSelect(file.id)}
              aria-current={props.selected === file.id ? "true" : undefined}
              title={file.path}
            >
              <FileText size={14} />
              <span>{name}</span>
              {props.dirty[file.id] && (
                <span className="dirty-dot" aria-label="Unsaved" />
              )}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Options for ${file.path}`}
                  disabled={props.readOnly}
                >
                  <MoreHorizontal size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onSelect={() => props.onAction(file, "rename")}
                >
                  <Pencil />
                  Rename or move
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => props.onAction(file, "delete")}
                >
                  <Trash2 />
                  Move to Trash
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          <div key={key}>
            <button
              className="file-item folder-item"
              style={{ paddingLeft: 12 + depth * 14 }}
              aria-expanded={!collapsed[key]}
              onClick={() => setCollapsed((v) => ({ ...v, [key]: !v[key] }))}
            >
              {collapsed[key] ? (
                <ChevronRight size={12} />
              ) : (
                <ChevronDown size={12} />
              )}
              <Folder size={14} />
              <span>{name}</span>
            </button>
            {!collapsed[key] && render(key + "/", depth + 1)}
          </div>
        );
      });
  }
  return (
    <nav aria-label="Project files" className="file-nav">
      {render("", 0)}
      {!props.files.length && (
        <p className="outline-empty">Add or upload a file to begin.</p>
      )}
    </nav>
  );
}
