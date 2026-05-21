"use client";

export type AttachmentUploadTargetType =
  | "issue"
  | "comment"
  | "project"
  | "initiative"
  | "cycle"
  | "chat-message"
  | "canvas";

export type InitAttachmentUpload = (input: {
  targetType: AttachmentUploadTargetType;
  targetId: string;
  filename: string;
  mimeType: string;
  size: number;
}) => Promise<{ attachmentId: string; uploadUrl: string }>;

export type FinalizeAttachmentUpload = (input: { attachmentId: string }) => Promise<unknown>;

export async function uploadAttachmentFile(args: {
  file: File;
  targetType: AttachmentUploadTargetType;
  targetId: string;
  initUpload: InitAttachmentUpload;
  finalize: FinalizeAttachmentUpload;
}): Promise<{ attachmentId: string }> {
  const { file, targetType, targetId, initUpload, finalize } = args;
  const mimeType = file.type || "application/octet-stream";
  const init = await initUpload({
    targetType,
    targetId,
    filename: file.name || "attachment",
    mimeType,
    size: file.size,
  });
  const put = await fetch(init.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: file,
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  await finalize({ attachmentId: init.attachmentId });
  return { attachmentId: init.attachmentId };
}
