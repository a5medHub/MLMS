import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { createAuditLog } from "../lib/audit";
import { HttpError } from "../lib/errors";
import { estimateLoanDueDate, type DueDateEstimate } from "../lib/reading-time";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const dueEstimateWaitMs = 1200;
const fallbackLoanDays = 30;

const borrowRequestQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "DECLINED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const createRequestSchema = z.object({
  bookId: z.string().min(1)
});

const requestIdParamsSchema = z.object({
  requestId: z.string().min(1)
});

const buildFallbackDueEstimate = (): DueDateEstimate => ({
  dueAt: new Date(Date.now() + fallbackLoanDays * 24 * 60 * 60 * 1000),
  days: fallbackLoanDays,
  source: "fallback",
  pageCount: null
});

const toDateOnly = (date: Date): string => date.toISOString().slice(0, 10);

const requestInclude = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      contactEmail: true,
      phoneNumber: true,
      personalId: true,
      readingPoints: true
    }
  },
  book: {
    select: {
      id: true,
      title: true,
      author: true,
      isbn: true,
      genre: true,
      publishedYear: true,
      description: true,
      coverUrl: true,
      averageRating: true,
      ratingsCount: true,
      aiMetadata: true,
      available: true,
      requestPending: true,
      createdAt: true,
      updatedAt: true
    }
  },
  reviewedBy: {
    select: {
      id: true,
      name: true,
      email: true
    }
  }
} as const;

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const viewer = req.user;
    if (!viewer) {
      throw new HttpError(401, "Authentication required");
    }
    const query = borrowRequestQuerySchema.parse(req.query);
    const where = {
      ...(viewer.role === "ADMIN" ? {} : { userId: viewer.id }),
      ...(query.status ? { status: query.status } : viewer.role === "ADMIN" ? { status: "PENDING" as const } : {})
    };

    const requests = await prisma.borrowRequest.findMany({
      where,
      include: requestInclude,
      orderBy: [{ createdAt: "desc" }],
      take: query.limit
    });

    const [pendingCount, unreadForMember] = await Promise.all([
      viewer.role === "ADMIN"
        ? prisma.borrowRequest.count({
            where: { status: "PENDING" }
          })
        : Promise.resolve(0),
      viewer.role === "MEMBER"
        ? prisma.borrowRequest.count({
            where: {
              userId: viewer.id,
              status: { in: ["APPROVED", "DECLINED"] },
              memberSeenAt: null
            }
          })
        : Promise.resolve(0)
    ]);

    res.status(200).json({
      data: requests,
      meta: {
        pendingCount,
        unreadForMember
      }
    });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole(["MEMBER"]),
  asyncHandler(async (req, res) => {
    const payload = createRequestSchema.parse(req.body);
    const viewer = req.user;
    if (!viewer) {
      throw new HttpError(401, "Authentication required");
    }

    const created = await prisma.$transaction(async (tx) => {
      const claim = await tx.book.updateMany({
        where: {
          id: payload.bookId,
          available: true,
          requestPending: false
        },
        data: {
          requestPending: true
        }
      });

      if (claim.count !== 1) {
        throw new HttpError(409, "Book is unavailable or already has a pending request");
      }

      const request = await tx.borrowRequest.create({
        data: {
          userId: viewer.id,
          bookId: payload.bookId,
          status: "PENDING",
          memberSeenAt: new Date()
        },
        include: requestInclude
      });

      return request;
    });

    await createAuditLog({
      actorUserId: viewer.id,
      action: "BOOK_BORROW_REQUESTED",
      entity: "BORROW_REQUEST",
      entityId: created.id,
      metadata: {
        bookId: created.bookId
      }
    });

    res.status(201).json({ data: created });
  })
);

router.post(
  "/:requestId/approve",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const params = requestIdParamsSchema.parse(req.params);
    const viewer = req.user;
    if (!viewer) {
      throw new HttpError(401, "Authentication required");
    }

    const existing = await prisma.borrowRequest.findUnique({
      where: { id: params.requestId },
      include: requestInclude
    });
    if (!existing) {
      throw new HttpError(404, "Borrow request not found");
    }
    if (existing.status !== "PENDING") {
      throw new HttpError(409, "Borrow request is no longer pending");
    }

    const dueEstimate = await Promise.race<DueDateEstimate>([
      estimateLoanDueDate({
        title: existing.book.title,
        author: existing.book.author,
        isbn: existing.book.isbn
      }).catch(() => buildFallbackDueEstimate()),
      new Promise<DueDateEstimate>((resolve) => {
        setTimeout(() => resolve(buildFallbackDueEstimate()), dueEstimateWaitMs);
      })
    ]);

    const result = await prisma.$transaction(async (tx) => {
      const updatedRequest = await tx.borrowRequest.updateMany({
        where: {
          id: params.requestId,
          status: "PENDING"
        },
        data: {
          status: "APPROVED",
          reviewedById: viewer.id,
          reviewedAt: new Date(),
          memberSeenAt: null
        }
      });

      if (updatedRequest.count !== 1) {
        throw new HttpError(409, "Borrow request is no longer pending");
      }

      const bookClaim = await tx.book.updateMany({
        where: {
          id: existing.bookId,
          available: true,
          requestPending: true
        },
        data: {
          available: false,
          requestPending: false
        }
      });
      if (bookClaim.count !== 1) {
        throw new HttpError(409, "Book is no longer available for approval");
      }

      const loan = await tx.loan.create({
        data: {
          userId: existing.userId,
          bookId: existing.bookId,
          dueAt: dueEstimate.dueAt
        },
        include: {
          book: true,
          user: {
            select: requestInclude.user.select
          }
        }
      });

      const request = await tx.borrowRequest.findUnique({
        where: { id: params.requestId },
        include: requestInclude
      });

      return { loan, request };
    });

    await createAuditLog({
      actorUserId: viewer.id,
      action: "BOOK_BORROW_REQUEST_APPROVED",
      entity: "BORROW_REQUEST",
      entityId: params.requestId,
      metadata: {
        bookId: existing.bookId,
        userId: existing.userId,
        dueAt: toDateOnly(dueEstimate.dueAt),
        dueDateSource: dueEstimate.source,
        estimatedReadingDays: dueEstimate.days
      }
    });

    res.status(200).json({
      data: result.request,
      meta: {
        loan: result.loan,
        dueDateSource: dueEstimate.source,
        estimatedReadingDays: dueEstimate.days
      }
    });
  })
);

router.post(
  "/:requestId/decline",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const params = requestIdParamsSchema.parse(req.params);
    const viewer = req.user;
    if (!viewer) {
      throw new HttpError(401, "Authentication required");
    }

    const existing = await prisma.borrowRequest.findUnique({
      where: { id: params.requestId }
    });
    if (!existing) {
      throw new HttpError(404, "Borrow request not found");
    }
    if (existing.status !== "PENDING") {
      throw new HttpError(409, "Borrow request is no longer pending");
    }

    const declined = await prisma.$transaction(async (tx) => {
      const updated = await tx.borrowRequest.updateMany({
        where: {
          id: params.requestId,
          status: "PENDING"
        },
        data: {
          status: "DECLINED",
          reviewedById: viewer.id,
          reviewedAt: new Date(),
          memberSeenAt: null
        }
      });
      if (updated.count !== 1) {
        throw new HttpError(409, "Borrow request is no longer pending");
      }

      await tx.book.updateMany({
        where: {
          id: existing.bookId,
          available: true,
          requestPending: true
        },
        data: {
          requestPending: false
        }
      });

      return tx.borrowRequest.findUnique({
        where: { id: params.requestId },
        include: requestInclude
      });
    });

    await createAuditLog({
      actorUserId: viewer.id,
      action: "BOOK_BORROW_REQUEST_DECLINED",
      entity: "BORROW_REQUEST",
      entityId: params.requestId,
      metadata: {
        bookId: existing.bookId,
        userId: existing.userId
      }
    });

    res.status(200).json({ data: declined });
  })
);

router.post(
  "/me/mark-seen",
  requireAuth,
  asyncHandler(async (req, res) => {
    const viewer = req.user;
    if (!viewer) {
      throw new HttpError(401, "Authentication required");
    }
    if (viewer.role !== "MEMBER") {
      res.status(200).json({ data: { updated: 0 } });
      return;
    }

    const result = await prisma.borrowRequest.updateMany({
      where: {
        userId: viewer.id,
        status: { in: ["APPROVED", "DECLINED"] },
        memberSeenAt: null
      },
      data: {
        memberSeenAt: new Date()
      }
    });

    res.status(200).json({
      data: {
        updated: result.count
      }
    });
  })
);

export const borrowRequestsRouter = router;

