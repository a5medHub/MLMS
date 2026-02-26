import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { createAuditLog } from "../lib/audit";
import { HttpError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";

const router = Router();

const checkoutSchema = z.object({
  bookId: z.string().min(1),
  dueAt: z.coerce.date().optional()
});

const checkinSchema = z.object({
  bookId: z.string().min(1)
});

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
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      },
      orderBy: [{ checkedOutAt: "desc" }]
    });

    res.status(200).json({ data: loans });
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

    const loan = await prisma.$transaction(async (tx) => {
      const book = await tx.book.findUnique({
        where: { id: payload.bookId }
      });
      if (!book) {
        throw new HttpError(404, "Book not found");
      }
      if (!book.available) {
        throw new HttpError(409, "Book is currently unavailable");
      }

      await tx.book.update({
        where: { id: payload.bookId },
        data: { available: false }
      });

      return tx.loan.create({
        data: {
          bookId: payload.bookId,
          userId: viewer.id,
          dueAt: payload.dueAt
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
      metadata: { bookId: payload.bookId }
    });

    res.status(201).json({ data: loan });
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

export const loansRouter = router;
