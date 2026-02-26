import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { createAuditLog } from "../lib/audit";
import { HttpError } from "../lib/errors";
import { enrichLibraryMetadata, persistExternalBooks, searchExternalBooks } from "../lib/external-books";
import { FALLBACK_BOOKS } from "../lib/fallback-books";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const BOOKS_CACHE_TTL_MS = 20_000;

type BooksPayload = {
  data: Array<{
    id: string;
    title: string;
    author: string;
    isbn: string | null;
    genre: string | null;
    publishedYear: number | null;
    description: string | null;
    coverUrl: string | null;
    averageRating: number | null;
    ratingsCount: number | null;
    available: boolean;
    createdAt: Date | string;
    updatedAt?: Date | string;
  }>;
  pageInfo: {
    hasNextPage: boolean;
    nextCursor: string | null;
  };
};

const booksCache = new Map<string, { expiresAt: number; payload: BooksPayload }>();
let lastBooksPayload: BooksPayload | null = null;
const invalidateBooksCache = (): void => {
  booksCache.clear();
  lastBooksPayload = null;
};

const hasValidAuthHeader = (authHeader?: string): boolean => {
  return typeof authHeader === "string" && authHeader.startsWith("Bearer ");
};

const getBooksCacheKey = (query: {
  q?: string;
  author?: string;
  genre?: string;
  available?: "true" | "false";
  cursor?: string;
  limit: number;
}): string => {
  return JSON.stringify({
    q: query.q ?? "",
    author: query.author ?? "",
    genre: query.genre ?? "",
    available: query.available ?? "",
    cursor: query.cursor ?? "",
    limit: query.limit
  });
};

const normalizeBookRecord = <TBook extends { averageRating?: number | null; ratingsCount?: number | null }>(
  book: TBook
): TBook & { averageRating: number | null; ratingsCount: number | null } => {
  return {
    ...book,
    averageRating: book.averageRating ?? null,
    ratingsCount: book.ratingsCount ?? null
  };
};

const isMissingColumnError = (error: unknown): boolean => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2022"
  );
};

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
    .transform((value) => value?.trim() || null),
  averageRating: z.coerce.number().min(0).max(5).optional().nullable(),
  ratingsCount: z.coerce.number().int().min(0).optional().nullable()
});

router.get(
  "/",
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
    const allowCache = !hasValidAuthHeader(req.headers.authorization);
    const cacheKey = getBooksCacheKey(query);
    const cached = booksCache.get(cacheKey);
    if (allowCache && cached && cached.expiresAt > Date.now()) {
      res.status(200).json(cached.payload);
      return;
    }

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

    const runPrimaryQuery = async () => {
      const books = await prisma.book.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {})
      });
      return books.map((book) => normalizeBookRecord(book));
    };

    const runLegacyQuery = async () => {
      const books = await prisma.book.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
        select: {
          id: true,
          title: true,
          author: true,
          isbn: true,
          genre: true,
          publishedYear: true,
          description: true,
          coverUrl: true,
          available: true,
          createdAt: true,
          updatedAt: true
        }
      });
      return books.map((book) =>
        normalizeBookRecord({
          ...book,
          averageRating: null,
          ratingsCount: null
        })
      );
    };

    let books: Awaited<ReturnType<typeof runPrimaryQuery>>;
    try {
      books = await runPrimaryQuery();
    } catch (error) {
      if (isMissingColumnError(error)) {
        books = await runLegacyQuery();
      } else if (lastBooksPayload) {
        res.status(200).json(lastBooksPayload);
        return;
      } else {
        const fallback = FALLBACK_BOOKS.slice(0, query.limit);
        res.status(200).json({
          data: fallback,
          pageInfo: {
            hasNextPage: false,
            nextCursor: null
          }
        });
        return;
      }
    }

    const hasNextPage = books.length > query.limit;
    const data = hasNextPage ? books.slice(0, query.limit) : books;
    const nextCursor = hasNextPage ? data[data.length - 1]?.id : null;

    const payload: BooksPayload = {
      data,
      pageInfo: {
        hasNextPage,
        nextCursor
      }
    };

    lastBooksPayload = payload;
    if (allowCache) {
      booksCache.set(cacheKey, {
        expiresAt: Date.now() + BOOKS_CACHE_TTL_MS,
        payload
      });
    }

    res.status(200).json(payload);
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
    invalidateBooksCache();

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

router.post(
  "/enrich-metadata",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const payload = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(200),
        provider: z.enum(["auto", "openlibrary", "google"]).default("auto"),
        onlyMissing: z
          .union([z.boolean(), z.literal("true"), z.literal("false")])
          .optional()
          .transform((value) => value === undefined || value === true || value === "true")
      })
      .parse(req.body ?? {});

    const result = await enrichLibraryMetadata({
      limit: payload.limit,
      provider: payload.provider,
      onlyMissing: payload.onlyMissing
    });
    invalidateBooksCache();

    await createAuditLog({
      actorUserId: req.user?.id,
      action: "BOOK_METADATA_ENRICH",
      entity: "BOOK",
      metadata: {
        limit: payload.limit,
        provider: payload.provider,
        onlyMissing: payload.onlyMissing,
        ...result
      }
    });

    res.status(200).json({
      meta: {
        providerUsed: payload.provider,
        ...result
      }
    });
  })
);

router.get(
  "/:bookId",
  asyncHandler(async (req, res) => {
    const params = z.object({ bookId: z.string().min(1) }).parse(req.params);
    let book: Awaited<ReturnType<typeof prisma.book.findUnique>>;
    try {
      book = await prisma.book.findUnique({ where: { id: params.bookId } });
    } catch (error) {
      if (!isMissingColumnError(error)) {
        throw error;
      }
      const legacyBook = await prisma.book.findUnique({
        where: { id: params.bookId },
        select: {
          id: true,
          title: true,
          author: true,
          isbn: true,
          genre: true,
          publishedYear: true,
          description: true,
          coverUrl: true,
          available: true,
          createdAt: true,
          updatedAt: true
        }
      });
      book = legacyBook
        ? ({
            ...legacyBook,
            averageRating: null,
            ratingsCount: null
          } as typeof book)
        : null;
    }
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
    invalidateBooksCache();
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
    invalidateBooksCache();
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
    invalidateBooksCache();
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
