import { EditorWorkspace } from "@/components/editor-workspace";
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EditorWorkspace projectId={id} />;
}
