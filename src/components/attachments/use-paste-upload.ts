"use client";
import { useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { attachmentMarkdownRef } from "./issue-attachments-panel";

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
 */
export function usePasteUpload(args: {
  targetType: "issue" | "comment" | "project" | "initiative" | "cycle";
  targetId: string;
  value: string;
  onChange: (next: string) => void;
  onUploaded?: () => void;
}) {
  const { targetType, targetId, value, onChange, onUploaded } = args;
  const initUpload = trpc.attachment.initUpload.useMutation();
  const finalize = trpc.attachment.finalize.useMutation();
  const utils = trpc.useUtils();

  const uploadAndInsert = useCallback(
    async (file: File, insertAt: number) => {
      try {
        const init = await initUpload.mutateAsync({
          targetType,
          targetId,
          filename: file.name || "pasted-image.png",
          mimeType: file.type || "application/octet-stream",
          size: file.size,
        });
        const put = await fetch(init.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);
        await finalize.mutateAsync({ attachmentId: init.attachmentId });
        const ref = attachmentMarkdownRef({
          attachmentId: init.attachmentId,
          filename: file.name || "attachment",
          mimeType: file.type || "application/octet-stream",
        });
        // Splice the markdown reference in at `insertAt`; sandwich with
        // newlines so it doesn't collide with surrounding prose.
        const before = value.slice(0, insertAt);
        const after = value.slice(insertAt);
        const sep = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
        const trail = after.startsWith("\n") || after.length === 0 ? "" : "\n";
        onChange(`${before}${sep}${ref}${trail}${after}`);
        if (targetType === "issue") {
          await utils.attachment.list.invalidate({
            targetType: "issue",
            targetId,
          });
          await utils.issue.byId.invalidate({ id: targetId });
        }
        onUploaded?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        toast.error(`${file.name || "file"}: ${message}`);
      }
    },
    [initUpload, finalize, utils, targetType, targetId, value, onChange, onUploaded],
  );

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
      for (const f of files) void uploadAndInsert(f, insertAt);
    },
    [uploadAndInsert, value],
  );

  return { onPaste };
}
