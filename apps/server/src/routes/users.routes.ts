import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { createAuditLog } from "../lib/audit";
import { HttpError } from "../lib/errors";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

router.get(
  "/",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true
      },
      orderBy: { createdAt: "asc" }
    });

    res.status(200).json({ data: users });
  })
);

router.patch(
  "/:userId/role",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const payload = z
      .object({
        role: z.enum(["ADMIN", "MEMBER"])
      })
      .parse(req.body);
    const params = z.object({ userId: z.string().min(1) }).parse(req.params);

    const target = await prisma.user.findUnique({
      where: { id: params.userId }
    });
    if (!target) {
      throw new HttpError(404, "User not found");
    }

    const updated = await prisma.user.update({
      where: { id: params.userId },
      data: { role: payload.role },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true
      }
    });

    await createAuditLog({
      actorUserId: req.user?.id,
      action: "USER_ROLE_UPDATED",
      entity: "USER",
      entityId: params.userId,
      metadata: { role: payload.role }
    });

    res.status(200).json({ data: updated });
  })
);

export const usersRouter = router;
