"use client";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  EditorState,
  Compartment,
  Prec,
  getDefaultExtensions,
} from "@uiw/react-codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import {
  yCollab,
  yUndoManagerKeymap,
  ySyncAnnotation,
} from "y-codemirror.next";
import type { CollaborationSession } from "@/lib/collaboration";

export function CollaborativeEditor({
  session,
  path,
  wrap,
  readOnly,
  onCreateEditor,
}: {
  session: CollaborationSession;
  path: string;
  wrap: boolean;
  readOnly: boolean;
  onCreateEditor: (view: EditorView) => void;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const config = useRef(new Compartment());
  const created = useRef(onCreateEditor);
  useEffect(() => {
    created.current = onCreateEditor;
  }, [onCreateEditor]);
  const locked = readOnly || state.readOnly || !state.ready || state.blocked;
  useEffect(() => {
    if (!container.current || !session.snapshot().ready) return;
    const instance = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: session.text.toString(),
        extensions: [
          ...getDefaultExtensions({
            theme: "light",
            basicSetup: { history: false },
            indentWithTab: true,
          }),
          yCollab(session.text, session.provider.awareness, {
            undoManager: session.undoManager,
          }),
          keymap.of(
            yUndoManagerKeymap.map((binding) => ({
              ...binding,
              run: (editor) =>
                editor.state.readOnly ? true : binding.run!(editor),
            })),
          ),
          Prec.highest(
            EditorView.domEventHandlers({
              beforeinput: (event, editor) => {
                if (
                  editor.state.readOnly &&
                  (event.inputType === "historyUndo" ||
                    event.inputType === "historyRedo")
                ) {
                  event.preventDefault();
                  return true;
                }
                return false;
              },
            }),
          ),
          // Bound offline drafts and reject local edits when the session is locked.
          // Remote Yjs transactions must still reach the view while read only.
          EditorState.transactionFilter.of((transaction) => {
            if (
              !transaction.docChanged ||
              transaction.annotation(ySyncAnnotation)
            )
              return transaction;
            const current = session.snapshot();
            if (
              current.readOnly ||
              !current.ready ||
              current.blocked ||
              transaction.newDoc.length > 1_000_000
            )
              return [];
            return transaction;
          }),
          config.current.of([]),
        ],
      }),
    });
    view.current = instance;
    created.current(instance);
    return () => {
      view.current = null;
      instance.destroy();
    };
  }, [session, state.ready]);
  useEffect(() => {
    view.current?.dispatch({
      effects: config.current.reconfigure([
        EditorState.readOnly.of(locked),
        EditorView.editable.of(!locked),
        ...(path.endsWith(".tex") ? [StreamLanguage.define(stex)] : []),
        ...(wrap ? [EditorView.lineWrapping] : []),
      ]),
    });
  }, [locked, path, wrap, state.ready]);
  return (
    <div
      ref={container}
      className={`latex-code-editor cm-theme-light${wrap ? " wrap-code" : ""}`}
      aria-label={`Source for ${path}`}
      style={{ height: "100%" }}
    />
  );
}
