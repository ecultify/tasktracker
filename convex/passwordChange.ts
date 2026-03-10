import { getAuthUserId } from "@convex-dev/auth/server";
import {
  retrieveAccount,
  modifyAccountCredentials,
} from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";

export const changePassword = action({
  args: {
    currentPassword: v.string(),
    newPassword: v.string(),
  },
  handler: async (ctx, { currentPassword, newPassword }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const user = await ctx.runQuery(api.users.getCurrentUser);
    if (!user?.email) throw new Error("User email not found");

    const retrieved = await retrieveAccount(ctx, {
      provider: "password",
      account: { id: user.email, secret: currentPassword },
    });

    if (!retrieved) {
      throw new Error("Current password is incorrect");
    }

    if (newPassword.length < 8) {
      throw new Error("New password must be at least 8 characters");
    }

    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { id: user.email, secret: newPassword },
    });
  },
});
