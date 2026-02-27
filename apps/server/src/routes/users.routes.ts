import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { createAuditLog } from "../lib/audit";
import { HttpError } from "../lib/errors";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const contactSchema = z.object({
  contactEmail: z.string().trim().email("Enter a valid contact email"),
  phoneNumber: z.string().trim().min(6, "Phone number is required").max(32),
  personalId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .nullable()
    .transform((value) => value?.trim() || null)
});

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
        contactEmail: true,
        phoneNumber: true,
        personalId: true,
        readingPoints: true,
        role: true,
        createdAt: true
      },
      orderBy: { createdAt: "asc" }
    });

    res.status(200).json({ data: users });
  })
);

router.patch(
  "/me/contact",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.user) {
      throw new HttpError(401, "Authentication required");
    }
    const payload = contactSchema.parse(req.body);

    if (payload.personalId) {
      const existingPersonalId = await prisma.user.findFirst({
        where: {
          personalId: payload.personalId,
          id: { not: req.user.id }
        },
        select: { id: true }
      });
      if (existingPersonalId) {
        throw new HttpError(409, "Personal ID already used by another member");
      }
    }

    const updated = await prisma.user
      .update({
        where: { id: req.user.id },
        data: {
          contactEmail: payload.contactEmail,
          phoneNumber: payload.phoneNumber,
          personalId: payload.personalId
        },
        select: {
          id: true,
          name: true,
          email: true,
          contactEmail: true,
          phoneNumber: true,
          personalId: true,
          readingPoints: true,
          role: true,
          createdAt: true
        }
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          Array.isArray(error.meta?.target) &&
          error.meta?.target.includes("personalId")
        ) {
          throw new HttpError(409, "Personal ID already used by another member");
        }
        throw error;
      });

    await createAuditLog({
      actorUserId: req.user.id,
      action: "USER_CONTACT_UPDATED",
      entity: "USER",
      entityId: req.user.id,
      metadata: {
        contactEmail: payload.contactEmail,
        phoneNumber: payload.phoneNumber,
        personalId: payload.personalId
      }
    });

    res.status(200).json({ data: updated });
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
        contactEmail: true,
        phoneNumber: true,
        personalId: true,
        readingPoints: true,
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
