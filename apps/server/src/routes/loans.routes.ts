import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { createAuditLog } from "../lib/audit";
import { HttpError } from "../lib/errors";
import { estimateLoanDueDate } from "../lib/reading-time";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const loanUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  contactEmail: true,
  phoneNumber: true,
  personalId: true
} as const;

const checkoutSchema = z.object({
  bookId: z.string().min(1),
  dueAt: z.coerce.date().optional()
});

const checkinSchema = z.object({
  bookId: z.string().min(1)
});

const updateDueDateSchema = z.object({
  dueAt: z.coerce.date()
});

const toDateOnly = (date: Date): string => date.toISOString().slice(0, 10);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const querySchema = z.object({
      status: z.enum(["active", "returned"]).optional(),
      userId: z.string().optional()
    });
    const query = querySchema.parse(req.query);
    const viewer = req.user;
    if (!viewer) {
      throw new HttpError(401, "Authentication required");
    }

    const where = {
      AND: [
        viewer.role === "ADMIN" && query.userId ? { userId: query.userId } : {},
        viewer.role === "MEMBER" ? { userId: viewer.id } : {},
        query.status === "active" ? { returnedAt: null } : {},
        query.status === "returned" ? { NOT: { returnedAt: null } } : {}
      ]
    };

    const loans = await prisma.loan.findMany({
      where,
      include: {
        book: true,
        user: {
          select: loanUserSelect
        }
      },
      orderBy: [{ checkedOutAt: "desc" }]
    });

    res.status(200).json({ data: loans });
  })
);

router.get(
  "/admin/overview",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const activeLoans = await prisma.loan.findMany({
      where: { returnedAt: null },
      include: {
        book: true,
        user: {
          select: loanUserSelect
        }
      },
      orderBy: [{ dueAt: "asc" }, { checkedOutAt: "asc" }]
    });

    const overdueLoans = activeLoans.filter((loan) => loan.dueAt && loan.dueAt < now);
    type ActiveLoan = (typeof activeLoans)[number];
    const byUser = new Map<
      string,
      {
        user: { id: string; name: string; email: string };
        activeLoans: ActiveLoan[];
        overdueCount: number;
      }
    >();

    activeLoans.forEach((loan) => {
      const key = loan.user.id;
      if (!byUser.has(key)) {
        byUser.set(key, {
          user: loan.user,
          activeLoans: [],
          overdueCount: 0
        });
      }
      const record = byUser.get(key)!;
      record.activeLoans.push(loan);
      if (loan.dueAt && loan.dueAt < now) {
        record.overdueCount += 1;
      }
    });

    res.status(200).json({
      data: {
        borrowers: [...byUser.values()],
        overdueLoans,
        overdueUsers: [...byUser.values()].filter((record) => record.overdueCount > 0).length
      }
    });
  })
);

router.get(
  "/due-soon",
  requireAuth,
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        days: z.coerce.number().int().min(1).max(30).default(3)
      })
      .parse(req.query);
    if (!req.user) {
      throw new HttpError(401, "Authentication required");
    }

    const now = new Date();
    const dueBefore = new Date(now);
    dueBefore.setDate(dueBefore.getDate() + query.days);

    const where = {
      returnedAt: null as null,
      dueAt: { not: null, gte: now, lte: dueBefore },
      ...(req.user.role === "MEMBER" ? { userId: req.user.id } : {})
    };

    const loans = await prisma.loan.findMany({
      where,
      include: {
        book: true,
        user: {
          select: loanUserSelect
        }
      },
      orderBy: [{ dueAt: "asc" }, { checkedOutAt: "asc" }]
    });

    res.status(200).json({ data: loans, meta: { days: query.days } });
  })
);

router.post(
  "/checkout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const payload = checkoutSchema.parse(req.body);
    const viewer = req.user;
    if (!viewer) {
      throw new HttpError(401, "Authentication required");
    }
    if (payload.dueAt && viewer.role !== "ADMIN") {
      throw new HttpError(403, "Only admins can manually set due dates at checkout");
    }

    const book = await prisma.book.findUnique({
      where: { id: payload.bookId }
    });
    if (!book) {
      throw new HttpError(404, "Book not found");
    }

    const dueEstimate = payload.dueAt
      ? null
      : await estimateLoanDueDate({
          title: book.title,
          author: book.author,
          isbn: book.isbn
        });
    const dueAt = payload.dueAt ?? dueEstimate?.dueAt;

    const loan = await prisma.$transaction(async (tx) => {
      const claimResult = await tx.book.updateMany({
        where: {
          id: payload.bookId,
          available: true
        },
        data: {
          available: false
        }
      });
      if (claimResult.count !== 1) {
        throw new HttpError(409, "Book is currently unavailable");
      }

      return tx.loan.create({
        data: {
          bookId: payload.bookId,
          userId: viewer.id,
          dueAt
        },
        include: {
          book: true
        }
      });
    });

    await createAuditLog({
      actorUserId: viewer.id,
      action: "BOOK_CHECKED_OUT",
      entity: "LOAN",
      entityId: loan.id,
      metadata: {
        bookId: payload.bookId,
        dueAt: dueAt ? toDateOnly(dueAt) : null,
        dueDateSource: dueEstimate?.source ?? "manual",
        estimatedReadingDays: dueEstimate?.days ?? null
      }
    });

    res.status(201).json({
      data: loan,
      meta: {
        dueDateSource: dueEstimate?.source ?? "manual",
        estimatedReadingDays: dueEstimate?.days ?? null
      }
    });
  })
);

router.post(
  "/checkin",
  requireAuth,
  asyncHandler(async (req, res) => {
    const payload = checkinSchema.parse(req.body);
    const viewer = req.user;
    if (!viewer) {
      throw new HttpError(401, "Authentication required");
    }

    const activeLoan = await prisma.loan.findFirst({
      where: { bookId: payload.bookId, returnedAt: null }
    });
    if (!activeLoan) {
      throw new HttpError(404, "No active loan found for this book");
    }
    if (viewer.role !== "ADMIN" && activeLoan.userId !== viewer.id) {
      throw new HttpError(403, "You can only check in your own loans");
    }

    const updatedLoan = await prisma.$transaction(async (tx) => {
      await tx.book.update({
        where: { id: payload.bookId },
        data: { available: true }
      });

      return tx.loan.update({
        where: { id: activeLoan.id },
        data: { returnedAt: new Date() },
        include: { book: true }
      });
    });

    await createAuditLog({
      actorUserId: viewer.id,
      action: "BOOK_CHECKED_IN",
      entity: "LOAN",
      entityId: updatedLoan.id,
      metadata: { bookId: payload.bookId }
    });

    res.status(200).json({ data: updatedLoan });
  })
);

router.patch(
  "/:loanId/due-date",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const params = z.object({ loanId: z.string().min(1) }).parse(req.params);
    const payload = updateDueDateSchema.parse(req.body);

    const loan = await prisma.loan.findUnique({
      where: { id: params.loanId },
      include: { book: true, user: { select: loanUserSelect } }
    });
    if (!loan) {
      throw new HttpError(404, "Loan not found");
    }
    if (loan.returnedAt) {
      throw new HttpError(409, "Cannot update due date for a returned loan");
    }

    const updated = await prisma.loan.update({
      where: { id: loan.id },
      data: { dueAt: payload.dueAt },
      include: { book: true, user: { select: loanUserSelect } }
    });

    await createAuditLog({
      actorUserId: req.user?.id,
      action: "LOAN_DUE_DATE_UPDATED",
      entity: "LOAN",
      entityId: loan.id,
      metadata: {
        previousDueAt: loan.dueAt ? toDateOnly(loan.dueAt) : null,
        newDueAt: toDateOnly(payload.dueAt),
        userId: loan.userId,
        bookId: loan.bookId
      }
    });

    res.status(200).json({ data: updated });
  })
);

export const loansRouter = router;
