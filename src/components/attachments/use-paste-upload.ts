"use client";
import { useCallback } from "react";
import { useUploadTarget, type AttachmentTargetType } from "./use-upload-target";

/**
 * Wire up a paste handler that intercepts pasted files (e.g. screenshots
 * from the OS clipboard), uploads them as attachments on the supplied
 * target, and inserts the resulting markdown reference into the textarea
 * at the current cursor position.
 *
 * Returns handlers suitable for spreading onto a <textarea>: `onPaste`.
 * The hook is target-agnostic — supply a `targetType`/`targetId` pair,
 * plus the textarea ref and its setter. Useful for both the issue
 * description and comment composer.
 *
 * Internally delegates to `useUploadTarget` so paste and drag-and-drop
 * (`useDropUpload`) share the same upload + insertion path.
 */
export function usePasteUpload(args: {
  targetType: AttachmentTargetType;
  targetId: string;
  value: string;
  onChange: (next: string) => void;
  onUploaded?: () => void;
}) {
  const { value } = args;
  const { uploadAndInsert } = useUploadTarget(args);

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      e.preventDefault();
      const target = e.currentTarget;
      const insertAt = target.selectionStart ?? value.length;
      for (const f of files) void uploadAndInsert({ file: f, insertAt });
    },
    [uploadAndInsert, value],
  );

  return { onPaste };
}
