import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadAttachmentFile } from "../../src/components/attachments/attachment-upload-client";

describe("uploadAttachmentFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads bytes then finalizes a chat-message attachment", async () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const initUpload = vi.fn().mockResolvedValue({ attachmentId: "cmatt123", uploadUrl: "https://upload.example/put" });
    const finalize = vi.fn().mockResolvedValue({ ok: true });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadAttachmentFile({
      file,
      targetType: "chat-message",
      targetId: "cmmsg123",
      initUpload,
      finalize,
    });

    expect(initUpload).toHaveBeenCalledWith({
      targetType: "chat-message",
      targetId: "cmmsg123",
      filename: "note.txt",
      mimeType: "text/plain",
      size: 5,
    });
    expect(fetchMock).toHaveBeenCalledWith("https://upload.example/put", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: file,
    });
    expect(finalize).toHaveBeenCalledWith({ attachmentId: "cmatt123" });
    expect(result).toEqual({ attachmentId: "cmatt123" });
  });

  it("does not finalize if the browser PUT fails", async () => {
    const file = new File(["nope"], "bad.bin", { type: "application/octet-stream" });
    const initUpload = vi.fn().mockResolvedValue({ attachmentId: "cmatt-bad", uploadUrl: "https://upload.example/fail" });
    const finalize = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(
      uploadAttachmentFile({
        file,
        targetType: "chat-message",
        targetId: "cmmsg123",
        initUpload,
        finalize,
      }),
    ).rejects.toThrow("Upload failed (503)");
    expect(finalize).not.toHaveBeenCalled();
  });
});
