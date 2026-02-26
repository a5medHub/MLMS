import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { createAuditLog } from "../lib/audit";
import { HttpError } from "../lib/errors";
import { persistExternalBooks, searchExternalBooks } from "../lib/external-books";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const bookInputSchema = z.object({
  title: z.string().min(1).max(200),
  author: z.string().min(1).max(200),
  isbn: z
    .string()
    .max(32)
    .optional()
    .nullable()
    .transform((value) => value?.trim() || null),
  genre: z
    .string()
    .max(100)
    .optional()
    .nullable()
    .transform((value) => value?.trim() || null),
  publishedYear: z.coerce.number().int().min(0).max(2100).optional().nullable(),
  description: z
    .string()
    .max(1500)
    .optional()
    .nullable()
    .transform((value) => value?.trim() || null),
  coverUrl: z
    .string()
    .url()
    .optional()
    .nullable()
    .transform((value) => value?.trim() || null)
});

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const querySchema = z.object({
      q: z.string().optional(),
      author: z.string().optional(),
      genre: z.string().optional(),
      available: z.enum(["true", "false"]).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).default(12)
    });

    const query = querySchema.parse(req.query);
    const where = {
      AND: [
        query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: "insensitive" as const } },
                { author: { contains: query.q, mode: "insensitive" as const } },
                { genre: { contains: query.q, mode: "insensitive" as const } },
                { isbn: { contains: query.q, mode: "insensitive" as const } }
              ]
            }
          : {},
        query.author ? { author: { contains: query.author, mode: "insensitive" as const } } : {},
        query.genre ? { genre: { contains: query.genre, mode: "insensitive" as const } } : {},
        typeof query.available === "string" ? { available: query.available === "true" } : {}
      ]
    };

    const books = await prisma.book.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {})
    });

    const hasNextPage = books.length > query.limit;
    const data = hasNextPage ? books.slice(0, query.limit) : books;
    const nextCursor = hasNextPage ? data[data.length - 1]?.id : null;

    res.status(200).json({
      data,
      pageInfo: {
        hasNextPage,
        nextCursor
      }
    });
  })
);

router.post(
  "/import/external",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const payload = z
      .object({
        query: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(300).default(100),
        provider: z.enum(["auto", "openlibrary", "google"]).default("auto")
      })
      .parse(req.body);

    const externalResult = await searchExternalBooks(payload.query, payload.limit, payload.provider);
    const persisted = await persistExternalBooks(externalResult.books);

    await createAuditLog({
      actorUserId: req.user?.id,
      action: "BOOK_IMPORT_EXTERNAL",
      entity: "BOOK",
      metadata: {
        query: payload.query,
        limit: payload.limit,
        provider: payload.provider,
        sourceUsed: externalResult.sourceUsed,
        fallbackUsed: externalResult.fallbackUsed,
        createdCount: persisted.createdCount,
        reusedCount: persisted.reusedCount
      }
    });

    res.status(200).json({
      data: persisted.books,
      meta: {
        sourceUsed: externalResult.sourceUsed,
        fallbackUsed: externalResult.fallbackUsed,
        importedCount: persisted.createdCount,
        existingCount: persisted.reusedCount
      }
    });
  })
);

router.get(
  "/:bookId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = z.object({ bookId: z.string().min(1) }).parse(req.params);
    const book = await prisma.book.findUnique({ where: { id: params.bookId } });
    if (!book) {
      throw new HttpError(404, "Book not found");
    }
    res.status(200).json({ data: book });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const payload = bookInputSchema.parse(req.body);
    const created = await prisma.book.create({
      data: payload
    });
    await createAuditLog({
      actorUserId: req.user?.id,
      action: "BOOK_CREATED",
      entity: "BOOK",
      entityId: created.id,
      metadata: { title: created.title }
    });
    res.status(201).json({ data: created });
  })
);

router.patch(
  "/:bookId",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const params = z.object({ bookId: z.string().min(1) }).parse(req.params);
    const payload = bookInputSchema.partial().parse(req.body);
    const updated = await prisma.book.update({
      where: { id: params.bookId },
      data: payload
    });
    await createAuditLog({
      actorUserId: req.user?.id,
      action: "BOOK_UPDATED",
      entity: "BOOK",
      entityId: updated.id
    });
    res.status(200).json({ data: updated });
  })
);

router.delete(
  "/:bookId",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const params = z.object({ bookId: z.string().min(1) }).parse(req.params);
    const activeLoan = await prisma.loan.findFirst({
      where: { bookId: params.bookId, returnedAt: null }
    });
    if (activeLoan) {
      throw new HttpError(409, "Cannot delete a book with an active loan");
    }

    await prisma.book.delete({ where: { id: params.bookId } });
    await createAuditLog({
      actorUserId: req.user?.id,
      action: "BOOK_DELETED",
      entity: "BOOK",
      entityId: params.bookId
    });
    res.status(204).send();
  })
);

export const booksRouter = router;
