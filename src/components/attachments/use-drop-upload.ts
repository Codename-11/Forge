"use client";
import { useCallback, useRef, useState } from "react";
import { useUploadTarget, type AttachmentTargetType } from "./use-upload-target";

/**
 * Drag-and-drop file uploader that mirrors `usePasteUpload` semantics —
 * both hooks share the underlying `useUploadTarget` primitive so a
 * dropped file ends up indistinguishable from a pasted one. Returns:
 *
 *   - `isOver`           — true while a file is dragged over the target
 *   - `onDragOver`       — spread onto the wrapper element
 *   - `onDragEnter`      — spread onto the wrapper element
 *   - `onDragLeave`      — spread onto the wrapper element
 *   - `onDrop`           — spread onto the wrapper element
 *
 * The hook tracks dragenter/leave with a counter to handle nested
 * children (the dragenter/leave events bubble through child elements,
 * so naive boolean state would flicker as the cursor crosses them).
 *
 * Inserts the markdown reference at the current cursor position of the
 * textarea inside the drop zone if there is one focused; otherwise
 * appends at end-of-text. This keeps the drag-onto-comment-composer UX
 * identical to paste.
 */
export function useDropUpload(args: {
  targetType: AttachmentTargetType;
  targetId: string;
  value: string;
  onChange: (next: string) => void;
  onUploaded?: () => void;
}) {
  const { uploadAndInsert } = useUploadTarget(args);
  const [isOver, setIsOver] = useState(false);
  const counterRef = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsOver(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    // Hint the browser to render a copy cursor instead of the default
    // "no-drop" icon when the file is over a non-form element.
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    counterRef.current = Math.max(0, counterRef.current - 1);
    if (counterRef.current === 0) setIsOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      counterRef.current = 0;
      setIsOver(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length === 0) return;
      // Best-effort cursor inference: if the drop target contains a
      // focused textarea, splice at its caret. Otherwise append at end.
      const active = document.activeElement;
      const insertAt =
        active instanceof HTMLTextAreaElement
          ? (active.selectionStart ?? undefined)
          : undefined;
      for (const f of files) void uploadAndInsert({ file: f, insertAt });
    },
    [uploadAndInsert],
  );

  return { isOver, onDragEnter, onDragOver, onDragLeave, onDrop };
}
