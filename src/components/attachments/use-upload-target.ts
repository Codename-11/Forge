"use client";
import { useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { attachmentMarkdownRef } from "./issue-attachments-panel";
import { uploadAttachmentFile, type AttachmentUploadTargetType } from "./attachment-upload-client";

/**
 * Shared upload primitive used by both `usePasteUpload` and
 * `useDropUpload`. Handles the three-step upload flow (initUpload →
 * PUT → finalize) for an arbitrary attachment target, then splices a
 * markdown reference into the supplied textarea state at the requested
 * cursor position.
 *
 * Both hooks converge on this so paste and drag-and-drop share invalidation
 * semantics, error-toast copy, and the markdown insertion shape — keeps
 * the UX of attaching from clipboard vs. dropping a file identical.
 */
export type AttachmentTargetType = AttachmentUploadTargetType;

export type UploadAndInsertArgs = {
  file: File;
  /** Caret position to splice the markdown ref at. Defaults to end-of-text. */
  insertAt?: number;
};

export function useUploadTarget(args: {
  targetType: AttachmentTargetType;
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
    async ({ file, insertAt }: UploadAndInsertArgs) => {
      const at = insertAt ?? value.length;
      try {
        const init = await uploadAttachmentFile({
          file,
          targetType,
          targetId,
          initUpload: initUpload.mutateAsync,
          finalize: finalize.mutateAsync,
        });
        const ref = attachmentMarkdownRef({
          attachmentId: init.attachmentId,
          filename: file.name || "attachment",
          mimeType: file.type || "application/octet-stream",
        });
        // Sandwich with newlines so the markdown ref doesn't collide
        // with surrounding prose.
        const before = value.slice(0, at);
        const after = value.slice(at);
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

  return { uploadAndInsert };
}
