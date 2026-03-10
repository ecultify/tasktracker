import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ─── Helper: find team lead for a user ─────────────
async function findTeamLeadForUser(ctx: any, userId: string) {
  const userTeams = await ctx.db
    .query("userTeams")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();
  if (userTeams.length === 0) return null;

  const teams = await Promise.all(
    userTeams.map((ut: any) => ctx.db.get(ut.teamId))
  );
  const team = teams.find((t: any) => t);
  return team ? { teamId: team._id, leadId: team.leadId, teamName: team.name } : null;
}

// ─── Helper: check if user is brand manager ────────
async function isBrandManager(ctx: any, userId: string, brandId: string) {
  const bms = await ctx.db
    .query("brandManagers")
    .withIndex("by_brand", (q: any) => q.eq("brandId", brandId))
    .collect();
  return bms.some((bm: any) => bm.managerId === userId);
}

// ─── Queries ────────────────────────────────────────

export const listDeliverables = query({
  args: { taskId: v.optional(v.id("tasks")) },
  handler: async (ctx, { taskId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    let deliverables;
    if (taskId) {
      deliverables = await ctx.db
        .query("deliverables")
        .withIndex("by_task", (q) => q.eq("taskId", taskId))
        .collect();
    } else {
      deliverables = await ctx.db.query("deliverables").collect();
    }

    const users = await ctx.db.query("users").collect();
    const tasks = await ctx.db.query("tasks").collect();
    const briefs = await ctx.db.query("briefs").collect();
    const allTeams = await ctx.db.query("teams").collect();

    const results = await Promise.all(
      deliverables.map(async (d) => {
        const submitter = users.find((u) => u._id === d.submittedBy);
        const reviewer = d.reviewedBy ? users.find((u) => u._id === d.reviewedBy) : null;
        const teamLeadReviewer = d.teamLeadReviewedBy ? users.find((u) => u._id === d.teamLeadReviewedBy) : null;
        const task = tasks.find((t) => t._id === d.taskId);
        const brief = task ? briefs.find((b) => b._id === task.briefId) : null;

        let files: { name: string; url: string }[] = [];
        if (d.fileIds && d.fileIds.length > 0) {
          files = await Promise.all(
            d.fileIds.map(async (fileId, idx) => {
              const url = await ctx.storage.getUrl(fileId);
              return {
                name: d.fileNames?.[idx] ?? "file",
                url: url ?? "",
              };
            })
          );
          files = files.filter((f) => f.url);
        }

        // Find submitter's team and lead
        let teamLeadName: string | null = null;
        let teamName: string | null = null;
        if (d.teamLeadReviewedBy) {
          teamLeadName = teamLeadReviewer?.name ?? teamLeadReviewer?.email ?? null;
          const submitterTeams = await ctx.db
            .query("userTeams")
            .withIndex("by_user", (q) => q.eq("userId", d.submittedBy))
            .collect();
          for (const ut of submitterTeams) {
            const team = allTeams.find((t) => t._id === ut.teamId);
            if (team && team.leadId === d.teamLeadReviewedBy) {
              teamName = team.name;
              break;
            }
          }
        }

        return {
          ...d,
          submitterName: submitter?.name ?? submitter?.email ?? "Unknown",
          reviewerName: reviewer?.name ?? reviewer?.email,
          taskTitle: task?.title ?? "Unknown",
          taskDuration: task?.duration ?? "—",
          briefTitle: brief?.title ?? "Unknown",
          briefId: brief?._id,
          brandId: brief?.brandId,
          files,
          teamLeadReviewerName: teamLeadName,
          teamName,
        };
      })
    );
    return results;
  },
});

export const listTeamLeadPendingApprovals = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_lead", (q) => q.eq("leadId", userId))
      .collect();
    if (teams.length === 0) return [];

    const teamIds = teams.map((t) => t._id);
    const allUserTeams = await ctx.db.query("userTeams").collect();
    const teamMemberIds = new Set(
      allUserTeams
        .filter((ut) => teamIds.includes(ut.teamId))
        .map((ut) => ut.userId)
    );

    const allDeliverables = await ctx.db.query("deliverables").collect();
    const pending = allDeliverables.filter(
      (d) => d.teamLeadStatus === "pending" && teamMemberIds.has(d.submittedBy)
    );

    const users = await ctx.db.query("users").collect();
    const tasks = await ctx.db.query("tasks").collect();
    const briefs = await ctx.db.query("briefs").collect();
    const brands = await ctx.db.query("brands").collect();

    const results = await Promise.all(
      pending.map(async (d) => {
        const submitter = users.find((u) => u._id === d.submittedBy);
        const task = tasks.find((t) => t._id === d.taskId);
        const brief = task ? briefs.find((b) => b._id === task.briefId) : null;
        const brand = brief?.brandId ? brands.find((b) => b._id === brief.brandId) : null;

        // Find brand managers for "pass to" display
        const brandManagerEntries = brief?.brandId
          ? await ctx.db
              .query("brandManagers")
              .withIndex("by_brand", (q) => q.eq("brandId", brief.brandId!))
              .collect()
          : [];
        const brandManagers = brandManagerEntries
          .map((bm) => {
            const mgr = users.find((u) => u._id === bm.managerId);
            return mgr ? { _id: mgr._id, name: mgr.name ?? mgr.email ?? "Unknown" } : null;
          })
          .filter(Boolean);

        let files: { name: string; url: string }[] = [];
        if (d.fileIds && d.fileIds.length > 0) {
          files = await Promise.all(
            d.fileIds.map(async (fileId, idx) => {
              const url = await ctx.storage.getUrl(fileId);
              return { name: d.fileNames?.[idx] ?? "file", url: url ?? "" };
            })
          );
          files = files.filter((f) => f.url);
        }

        return {
          ...d,
          submitterName: submitter?.name ?? submitter?.email ?? "Unknown",
          taskTitle: task?.title ?? "Unknown",
          taskDuration: task?.duration ?? "—",
          briefTitle: brief?.title ?? "Unknown",
          briefId: brief?._id,
          brandName: brand?.name ?? "No Brand",
          brandId: brief?.brandId,
          brandManagers,
          files,
        };
      })
    );
    return results;
  },
});

export const listManagerDeliverables = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const myBrandAssignments = await ctx.db
      .query("brandManagers")
      .withIndex("by_manager", (q) => q.eq("managerId", userId))
      .collect();
    if (myBrandAssignments.length === 0) return [];

    const myBrandIds = new Set(myBrandAssignments.map((bm) => bm.brandId));

    const allDeliverables = await ctx.db.query("deliverables").collect();
    const tasks = await ctx.db.query("tasks").collect();
    const briefs = await ctx.db.query("briefs").collect();
    const users = await ctx.db.query("users").collect();
    const brands = await ctx.db.query("brands").collect();
    const allTeams = await ctx.db.query("teams").collect();

    const passed = allDeliverables.filter((d) => {
      if (d.teamLeadStatus !== "approved" || !d.passedToManagerAt) return false;
      if (d.status === "approved" || d.status === "rejected") return false;
      const task = tasks.find((t) => t._id === d.taskId);
      const brief = task ? briefs.find((b) => b._id === task.briefId) : null;
      return brief?.brandId && myBrandIds.has(brief.brandId);
    });

    const results = await Promise.all(
      passed.map(async (d) => {
        const submitter = users.find((u) => u._id === d.submittedBy);
        const teamLeadReviewer = d.teamLeadReviewedBy
          ? users.find((u) => u._id === d.teamLeadReviewedBy)
          : null;
        const task = tasks.find((t) => t._id === d.taskId);
        const brief = task ? briefs.find((b) => b._id === task.briefId) : null;
        const brand = brief?.brandId ? brands.find((b) => b._id === brief.brandId) : null;

        let teamName: string | null = null;
        if (d.teamLeadReviewedBy) {
          const submitterUserTeams = await ctx.db
            .query("userTeams")
            .withIndex("by_user", (q) => q.eq("userId", d.submittedBy))
            .collect();
          for (const ut of submitterUserTeams) {
            const team = allTeams.find((t) => t._id === ut.teamId);
            if (team && team.leadId === d.teamLeadReviewedBy) {
              teamName = team.name;
              break;
            }
          }
        }

        let files: { name: string; url: string }[] = [];
        if (d.fileIds && d.fileIds.length > 0) {
          files = await Promise.all(
            d.fileIds.map(async (fileId, idx) => {
              const url = await ctx.storage.getUrl(fileId);
              return { name: d.fileNames?.[idx] ?? "file", url: url ?? "" };
            })
          );
          files = files.filter((f) => f.url);
        }

        return {
          ...d,
          submitterName: submitter?.name ?? submitter?.email ?? "Unknown",
          taskTitle: task?.title ?? "Unknown",
          taskDuration: task?.duration ?? "—",
          briefTitle: brief?.title ?? "Unknown",
          briefId: brief?._id,
          brandName: brand?.name ?? "No Brand",
          brandId: brief?.brandId,
          teamLeadReviewerName: teamLeadReviewer?.name ?? teamLeadReviewer?.email ?? null,
          teamName,
          files,
        };
      })
    );
    return results;
  },
});

export const getTeamLeadPendingCount = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return 0;

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_lead", (q) => q.eq("leadId", userId))
      .collect();
    if (teams.length === 0) return 0;

    const teamIds = teams.map((t) => t._id);
    const allUserTeams = await ctx.db.query("userTeams").collect();
    const teamMemberIds = new Set(
      allUserTeams.filter((ut) => teamIds.includes(ut.teamId)).map((ut) => ut.userId)
    );

    const allDeliverables = await ctx.db.query("deliverables").collect();
    return allDeliverables.filter(
      (d) => d.teamLeadStatus === "pending" && teamMemberIds.has(d.submittedBy)
    ).length;
  },
});

// ─── Mutations ──────────────────────────────────────

export const submitDeliverable = mutation({
  args: {
    taskId: v.id("tasks"),
    message: v.string(),
    link: v.optional(v.string()),
    fileIds: v.optional(v.array(v.id("_storage"))),
    fileNames: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { taskId, message, link, fileIds, fileNames }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");

    const deliverableId = await ctx.db.insert("deliverables", {
      taskId,
      submittedBy: userId,
      message,
      link,
      submittedAt: Date.now(),
      status: "pending",
      teamLeadStatus: "pending",
      ...(fileIds && fileIds.length > 0 ? { fileIds } : {}),
      ...(fileNames && fileNames.length > 0 ? { fileNames } : {}),
    });

    const user = await ctx.db.get(userId);
    const teamInfo = await findTeamLeadForUser(ctx, userId);

    if (teamInfo?.leadId) {
      await ctx.db.insert("notifications", {
        recipientId: teamInfo.leadId,
        type: "deliverable_submitted",
        title: "Deliverable submitted for review",
        message: `${user?.name ?? "Someone"} submitted a deliverable for "${task.title}"`,
        briefId: task.briefId,
        taskId,
        triggeredBy: userId,
        read: false,
        createdAt: Date.now(),
      });
    }

    // Also notify the assigner
    if (task.assignedBy !== teamInfo?.leadId) {
      await ctx.db.insert("notifications", {
        recipientId: task.assignedBy,
        type: "deliverable_submitted",
        title: "Deliverable submitted",
        message: `${user?.name ?? "Someone"} submitted a deliverable for "${task.title}"`,
        briefId: task.briefId,
        taskId,
        triggeredBy: userId,
        read: false,
        createdAt: Date.now(),
      });
    }

    return deliverableId;
  },
});

export const teamLeadApprove = mutation({
  args: {
    deliverableId: v.id("deliverables"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { deliverableId, note }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const deliverable = await ctx.db.get(deliverableId);
    if (!deliverable) throw new Error("Deliverable not found");

    const teamInfo = await findTeamLeadForUser(ctx, deliverable.submittedBy);
    if (!teamInfo || teamInfo.leadId !== userId) {
      throw new Error("Only the team lead can approve this deliverable");
    }

    await ctx.db.patch(deliverableId, {
      teamLeadStatus: "approved",
      teamLeadReviewedBy: userId,
      teamLeadReviewNote: note,
      teamLeadReviewedAt: Date.now(),
    });

    const user = await ctx.db.get(userId);
    const task = await ctx.db.get(deliverable.taskId);
    await ctx.db.insert("notifications", {
      recipientId: deliverable.submittedBy,
      type: "deliverable_approved",
      title: "Deliverable approved by team lead",
      message: `${user?.name ?? "Team lead"} approved your deliverable for "${task?.title ?? "a task"}"`,
      briefId: task?.briefId,
      taskId: deliverable.taskId,
      triggeredBy: userId,
      read: false,
      createdAt: Date.now(),
    });
  },
});

export const teamLeadReject = mutation({
  args: {
    deliverableId: v.id("deliverables"),
    note: v.string(),
  },
  handler: async (ctx, { deliverableId, note }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const deliverable = await ctx.db.get(deliverableId);
    if (!deliverable) throw new Error("Deliverable not found");

    const teamInfo = await findTeamLeadForUser(ctx, deliverable.submittedBy);
    if (!teamInfo || teamInfo.leadId !== userId) {
      throw new Error("Only the team lead can reject this deliverable");
    }

    await ctx.db.patch(deliverableId, {
      teamLeadStatus: "changes_requested",
      teamLeadReviewedBy: userId,
      teamLeadReviewNote: note,
      teamLeadReviewedAt: Date.now(),
    });

    const task = await ctx.db.get(deliverable.taskId);
    if (task && task.status === "review") {
      await ctx.db.patch(deliverable.taskId, { status: "in-progress" });
    }

    const user = await ctx.db.get(userId);
    await ctx.db.insert("notifications", {
      recipientId: deliverable.submittedBy,
      type: "deliverable_rejected",
      title: "Changes requested by team lead",
      message: `${user?.name ?? "Team lead"} requested changes on your deliverable for "${task?.title ?? "a task"}": ${note}`,
      briefId: task?.briefId,
      taskId: deliverable.taskId,
      triggeredBy: userId,
      read: false,
      createdAt: Date.now(),
    });
  },
});

export const passToManager = mutation({
  args: {
    deliverableId: v.id("deliverables"),
  },
  handler: async (ctx, { deliverableId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const deliverable = await ctx.db.get(deliverableId);
    if (!deliverable) throw new Error("Deliverable not found");

    if (deliverable.teamLeadStatus !== "approved") {
      throw new Error("Deliverable must be approved by team lead first");
    }

    const teamInfo = await findTeamLeadForUser(ctx, deliverable.submittedBy);
    if (!teamInfo || teamInfo.leadId !== userId) {
      throw new Error("Only the team lead can pass this deliverable to the manager");
    }

    await ctx.db.patch(deliverableId, {
      passedToManagerBy: userId,
      passedToManagerAt: Date.now(),
    });

    const task = await ctx.db.get(deliverable.taskId);
    const brief = task ? await ctx.db.get(task.briefId) : null;

    if (brief?.brandId) {
      const brandManagers = await ctx.db
        .query("brandManagers")
        .withIndex("by_brand", (q) => q.eq("brandId", brief.brandId!))
        .collect();

      const user = await ctx.db.get(userId);
      for (const bm of brandManagers) {
        await ctx.db.insert("notifications", {
          recipientId: bm.managerId,
          type: "deliverable_submitted",
          title: "Deliverable ready for review",
          message: `${user?.name ?? "Team lead"} passed a deliverable for "${task?.title ?? "a task"}" for your review`,
          briefId: task?.briefId,
          taskId: deliverable.taskId,
          triggeredBy: userId,
          read: false,
          createdAt: Date.now(),
        });
      }
    }
  },
});

export const approveDeliverable = mutation({
  args: {
    deliverableId: v.id("deliverables"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { deliverableId, note }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const deliverable = await ctx.db.get(deliverableId);
    if (!deliverable) throw new Error("Deliverable not found");

    const task = await ctx.db.get(deliverable.taskId);
    const brief = task ? await ctx.db.get(task.briefId) : null;

    if (brief?.brandId) {
      const isManager = await isBrandManager(ctx, userId, brief.brandId);
      if (!isManager) {
        throw new Error("Only brand managers can give final approval");
      }
    } else {
      const user = await ctx.db.get(userId);
      if (!user || user.role !== "admin") {
        throw new Error("Not authorized to approve");
      }
    }

    await ctx.db.patch(deliverableId, {
      status: "approved",
      reviewedBy: userId,
      reviewNote: note,
      reviewedAt: Date.now(),
    });

    if (task) {
      await ctx.db.patch(deliverable.taskId, {
        status: "done",
        completedAt: Date.now(),
      });
    }

    await ctx.db.insert("notifications", {
      recipientId: deliverable.submittedBy,
      type: "deliverable_approved",
      title: "Deliverable approved",
      message: `Your deliverable for "${task?.title ?? "a task"}" was approved`,
      briefId: task?.briefId,
      taskId: deliverable.taskId,
      triggeredBy: userId,
      read: false,
      createdAt: Date.now(),
    });
  },
});

export const rejectDeliverable = mutation({
  args: {
    deliverableId: v.id("deliverables"),
    note: v.string(),
  },
  handler: async (ctx, { deliverableId, note }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const deliverable = await ctx.db.get(deliverableId);
    if (!deliverable) throw new Error("Deliverable not found");

    const task = await ctx.db.get(deliverable.taskId);
    const brief = task ? await ctx.db.get(task.briefId) : null;

    if (brief?.brandId) {
      const isManager = await isBrandManager(ctx, userId, brief.brandId);
      if (!isManager) {
        throw new Error("Only brand managers can reject deliverables");
      }
    } else {
      const user = await ctx.db.get(userId);
      if (!user || user.role !== "admin") {
        throw new Error("Not authorized to reject");
      }
    }

    await ctx.db.patch(deliverableId, {
      status: "rejected",
      reviewedBy: userId,
      reviewNote: note,
      reviewedAt: Date.now(),
      teamLeadStatus: undefined,
      teamLeadReviewedBy: undefined,
      teamLeadReviewNote: undefined,
      teamLeadReviewedAt: undefined,
      passedToManagerBy: undefined,
      passedToManagerAt: undefined,
    });

    if (task && task.status === "review") {
      await ctx.db.patch(deliverable.taskId, { status: "in-progress" });
    }

    await ctx.db.insert("notifications", {
      recipientId: deliverable.submittedBy,
      type: "deliverable_rejected",
      title: "Changes requested",
      message: `Changes requested on your deliverable for "${task?.title ?? "a task"}": ${note}`,
      briefId: task?.briefId,
      taskId: deliverable.taskId,
      triggeredBy: userId,
      read: false,
      createdAt: Date.now(),
    });
  },
});

export const deleteDeliverable = mutation({
  args: { deliverableId: v.id("deliverables") },
  handler: async (ctx, { deliverableId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const user = await ctx.db.get(userId);
    if (!user || user.role !== "admin") {
      throw new Error("Only admins can delete deliverables");
    }

    const deliverable = await ctx.db.get(deliverableId);
    if (!deliverable) throw new Error("Deliverable not found");

    if (deliverable.fileIds) {
      for (const fileId of deliverable.fileIds) {
        await ctx.storage.delete(fileId);
      }
    }

    await ctx.db.delete(deliverableId);
  },
});
