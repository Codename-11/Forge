import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router, withRateLimit } from "@/server/trpc";
import {
  ALLOWED_AVATAR_MIME_TYPES,
  InvalidAvatarError,
  MAX_AVATAR_SIZE_BYTES,
  finalizeUserAvatar,
  getUserAvatarState,
  presignUserAvatarUpload,
  removeUserAvatar,
} from "@/server/services/user-avatar";
import { StorageNotConfiguredError } from "@/server/services/storage";

function avatarError(error: unknown): TRPCError {
  if (error instanceof StorageNotConfiguredError) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
  }
  if (error instanceof InvalidAvatarError) {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Avatar operation failed." });
}

const avatarWriteProcedure = protectedProcedure.use(withRateLimit(10, 60));

export const avatarRouter = router({
  me: protectedProcedure.query(({ ctx }) => getUserAvatarState(ctx.session.user.id)),

  initUpload: avatarWriteProcedure
    .input(
      z.object({
        contentType: z.enum(ALLOWED_AVATAR_MIME_TYPES),
        sizeBytes: z.number().int().positive().max(MAX_AVATAR_SIZE_BYTES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await presignUserAvatarUpload({ userId: ctx.session.user.id, ...input });
      } catch (error) {
        throw avatarError(error);
      }
    }),

  finalize: avatarWriteProcedure
    .input(z.object({ objectKey: z.string().min(1).max(512) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const avatar = await finalizeUserAvatar({
          userId: ctx.session.user.id,
          objectKey: input.objectKey,
        });
        await ctx.db.instanceAuditLog.create({
          data: {
            actorId: ctx.session.user.id,
            targetUserId: ctx.session.user.id,
            action: "USER_AVATAR_UPDATED",
            metadata: { contentType: avatar.contentType, sizeBytes: avatar.sizeBytes },
            ipAddress: ctx.ip,
            userAgent: ctx.userAgent,
          },
        });
        return avatar;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw avatarError(error);
      }
    }),

  remove: avatarWriteProcedure.mutation(async ({ ctx }) => {
    try {
      const result = await removeUserAvatar(ctx.session.user.id);
      if (result.removed) {
        await ctx.db.instanceAuditLog.create({
          data: {
            actorId: ctx.session.user.id,
            targetUserId: ctx.session.user.id,
            action: "USER_AVATAR_REMOVED",
            ipAddress: ctx.ip,
            userAgent: ctx.userAgent,
          },
        });
      }
      return {
        ...result,
        fallback: await getUserAvatarState(ctx.session.user.id),
      };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw avatarError(error);
    }
  }),
});
