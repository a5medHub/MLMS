import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { createAuditLog } from "../lib/audit";
import { HttpError } from "../lib/errors";
import {
  enrichLibraryMetadata,
  enrichMissingCoreMetadata,
  persistExternalBooks,
  searchExternalBooks
} from "../lib/external-books";
import { FALLBACK_BOOKS } from "../lib/fallback-books";
import { optionalAuth, requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const BOOKS_CACHE_TTL_MS = 20_000;
const AUTO_CORE_ENRICH_COOLDOWN_MS = 5 * 60 * 1000;

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
    aiMetadata: boolean;
    available: boolean;
    requestPending: boolean;
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
let autoCoreEnrichmentInProgress = false;
let autoCoreEnrichmentLastRunAt = 0;
const invalidateBooksCache = (): void => {
  booksCache.clear();
  lastBooksPayload = null;
};

const maybeTriggerAutoCoreMetadataEnrichment = (): void => {
  const now = Date.now();
  if (autoCoreEnrichmentInProgress) {
    return;
  }
  if (now - autoCoreEnrichmentLastRunAt < AUTO_CORE_ENRICH_COOLDOWN_MS) {
    return;
  }

  autoCoreEnrichmentInProgress = true;
  autoCoreEnrichmentLastRunAt = now;
  void enrichMissingCoreMetadata({
    limit: 300,
    provider: "auto"
  })
    .then((result) => {
      if (result.updatedCount > 0) {
        invalidateBooksCache();
      }
    })
    .catch(() => {
      // no-op: background enrichment should not impact API response path
    })
    .finally(() => {
      autoCoreEnrichmentInProgress = false;
    });
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

const normalizeBookRecord = <
  TBook extends {
    averageRating?: number | null;
    ratingsCount?: number | null;
    aiMetadata?: boolean | null;
    requestPending?: boolean | null;
  }
>(
  book: TBook
): TBook & {
  averageRating: number | null;
  ratingsCount: number | null;
  aiMetadata: boolean;
  requestPending: boolean;
} => {
  return {
    ...book,
    averageRating: book.averageRating ?? null,
    ratingsCount: book.ratingsCount ?? null,
    aiMetadata: book.aiMetadata ?? false,
    requestPending: book.requestPending ?? false
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

const reviewInputSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  content: z.string().trim().min(3).max(1500)
});

const noteInputSchema = z.object({
  content: z.string().trim().min(1).max(3000)
});

const isMissingTableError = (error: unknown): boolean => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2021"
  );
};

const findBookById = async (bookId: string) => {
  try {
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    return book ? normalizeBookRecord(book) : null;
  } catch (error) {
    if (!isMissingColumnError(error)) {
      throw error;
    }
    const legacyBook = await prisma.book.findUnique({
      where: { id: bookId },
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
    if (!legacyBook) {
      return null;
    }
    return normalizeBookRecord({
      ...legacyBook,
      averageRating: null,
      ratingsCount: null,
      aiMetadata: false,
      requestPending: false
    });
  }
};

const findRelatedBooks = async (
  book: Awaited<ReturnType<typeof findBookById>>,
  limit: number
): Promise<Array<ReturnType<typeof normalizeBookRecord>>> => {
  if (!book) {
    return [];
  }
  const boundedLimit = Math.max(1, Math.min(12, limit));
  const relatedOrConditions: Array<Record<string, unknown>> = [
    { author: { equals: book.author, mode: "insensitive" as const } }
  ];
  if (book.genre) {
    relatedOrConditions.push({ genre: { equals: book.genre, mode: "insensitive" as const } });
  }

  const runRelatedQuery = async (where: Record<string, unknown>, take: number) => {
    try {
      const records = await prisma.book.findMany({
        where,
        orderBy: [{ available: "desc" }, { averageRating: "desc" }, { ratingsCount: "desc" }, { createdAt: "desc" }],
        take
      });
      return records.map((record) => normalizeBookRecord(record));
    } catch (error) {
      if (!isMissingColumnError(error)) {
        throw error;
      }
      const records = await prisma.book.findMany({
        where,
        orderBy: [{ available: "desc" }, { createdAt: "desc" }],
        take,
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
      return records.map((record) =>
        normalizeBookRecord({
          ...record,
          averageRating: null,
          ratingsCount: null,
          aiMetadata: false,
          requestPending: false
        })
      );
    }
  };

  const strictMatches = await runRelatedQuery(
    {
      id: { not: book.id },
      OR: relatedOrConditions
    },
    boundedLimit
  );
  if (strictMatches.length >= boundedLimit) {
    return strictMatches;
  }

  const authorToken = book.author
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .slice(-1)[0];

  const relaxedOrConditions: Array<Record<string, unknown>> = [];
  if (book.genre) {
    relaxedOrConditions.push({ genre: { contains: book.genre, mode: "insensitive" as const } });
  }
  if (authorToken) {
    relaxedOrConditions.push({ author: { contains: authorToken, mode: "insensitive" as const } });
  }

  const excludedIds = [book.id, ...strictMatches.map((item) => item.id)];
  const relaxedMatches =
    relaxedOrConditions.length > 0
      ? await runRelatedQuery(
          {
            id: { notIn: excludedIds },
            OR: relaxedOrConditions
          },
          boundedLimit - strictMatches.length
        )
      : [];

  const combined = [...strictMatches, ...relaxedMatches];
  if (combined.length >= boundedLimit) {
    return combined.slice(0, boundedLimit);
  }

  const fillMatches = await runRelatedQuery(
    {
      id: { notIn: [book.id, ...combined.map((item) => item.id)] }
    },
    boundedLimit - combined.length
  );

  return [...combined, ...fillMatches].slice(0, boundedLimit);
};

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
        orderBy: [{ available: "desc" }, { requestPending: "asc" }, { createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {})
      });
      return books.map((book) => normalizeBookRecord(book));
    };

    const runLegacyQuery = async () => {
      const books = await prisma.book.findMany({
        where,
        orderBy: [{ available: "desc" }, { createdAt: "desc" }, { id: "desc" }],
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
          ratingsCount: null,
          aiMetadata: false,
          requestPending: false
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

    maybeTriggerAutoCoreMetadataEnrichment();
    res.status(200).json(payload);
  })
);

router.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    try {
      const [totalBooks, availableBooks, activeLoans] = await Promise.all([
        prisma.book.count(),
        prisma.book.count({ where: { available: true, requestPending: false } }),
        prisma.loan.count({ where: { returnedAt: null } })
      ]);

      res.status(200).json({
        data: {
          totalBooks,
          availableBooks,
          checkedOutBooks: Math.max(0, totalBooks - availableBooks),
          activeLoans
        }
      });
      return;
    } catch {
      const availableBooks = FALLBACK_BOOKS.filter((book) => book.available).length;
      const totalBooks = FALLBACK_BOOKS.length;
      res.status(200).json({
        data: {
          totalBooks,
          availableBooks,
          checkedOutBooks: Math.max(0, totalBooks - availableBooks),
          activeLoans: 0
        }
      });
    }
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
  "/enrich-core-metadata",
  requireAuth,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const payload = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(300),
        provider: z.enum(["auto", "openlibrary", "google"]).default("auto")
      })
      .parse(req.body ?? {});

    const result = await enrichMissingCoreMetadata({
      limit: payload.limit,
      provider: payload.provider
    });
    invalidateBooksCache();

    await createAuditLog({
      actorUserId: req.user?.id,
      action: "BOOK_CORE_METADATA_ENRICH",
      entity: "BOOK",
      metadata: {
        limit: payload.limit,
        provider: payload.provider,
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
  "/:bookId/details",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const params = z.object({ bookId: z.string().min(1) }).parse(req.params);
    const query = z
      .object({
        relatedLimit: z.coerce.number().int().min(1).max(12).default(8),
        reviewLimit: z.coerce.number().int().min(1).max(40).default(20)
      })
      .parse(req.query);

    const book = await findBookById(params.bookId);
    if (!book) {
      throw new HttpError(404, "Book not found");
    }

    const relatedBooks = await findRelatedBooks(book, query.relatedLimit);

    let reviews: Array<{
      id: string;
      rating: number;
      content: string;
      createdAt: Date;
      updatedAt: Date;
      user: { id: string; name: string; readingPoints: number };
    }> = [];
    let myReview: { id: string; rating: number; content: string; updatedAt: Date } | null = null;
    let myNote: { id: string; content: string; updatedAt: Date } | null = null;

    try {
      reviews = await prisma.bookReview.findMany({
        where: { bookId: params.bookId },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              readingPoints: true
            }
          }
        },
        orderBy: [{ updatedAt: "desc" }],
        take: query.reviewLimit
      });

      if (req.user) {
        const [review, note] = await Promise.all([
          prisma.bookReview.findUnique({
            where: {
              bookId_userId: {
                bookId: params.bookId,
                userId: req.user.id
              }
            },
            select: {
              id: true,
              rating: true,
              content: true,
              updatedAt: true
            }
          }),
          prisma.bookNote.findUnique({
            where: {
              bookId_userId: {
                bookId: params.bookId,
                userId: req.user.id
              }
            },
            select: {
              id: true,
              content: true,
              updatedAt: true
            }
          })
        ]);
        myReview = review;
        myNote = note;
      }
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error;
      }
    }

    const reviewSummary = reviews.reduce(
      (acc, review) => {
        acc.count += 1;
        acc.total += review.rating;
        return acc;
      },
      { count: 0, total: 0 }
    );

    res.status(200).json({
      data: {
        book,
        relatedBooks,
        reviews,
        myReview,
        myNote,
        reviewSummary: {
          count: reviewSummary.count,
          averageRating:
            reviewSummary.count > 0 ? Number((reviewSummary.total / reviewSummary.count).toFixed(2)) : null
        }
      }
    });
  })
);

router.put(
  "/:bookId/review",
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = z.object({ bookId: z.string().min(1) }).parse(req.params);
    const payload = reviewInputSchema.parse(req.body);

    const viewer = req.user;
    if (!viewer) {
      throw new HttpError(401, "Authentication required");
    }

    const book = await findBookById(params.bookId);
    if (!book) {
      throw new HttpError(404, "Book not found");
    }

    try {
      const saved = await prisma.bookReview.upsert({
        where: {
          bookId_userId: {
            bookId: params.bookId,
            userId: viewer.id
          }
        },
        update: {
          rating: payload.rating,
          content: payload.content
        },
        create: {
          bookId: params.bookId,
          userId: viewer.id,
          rating: payload.rating,
          content: payload.content
        }
      });

      await createAuditLog({
        actorUserId: viewer.id,
        action: "BOOK_REVIEW_SAVED",
        entity: "BOOK_REVIEW",
        entityId: saved.id,
        metadata: {
          bookId: params.bookId,
          rating: payload.rating
        }
      });

      res.status(200).json({
        data: saved
      });
    } catch (error) {
      if (isMissingTableError(error)) {
        throw new HttpError(503, "Book reviews are not initialized yet. Run database sync.");
      }
      throw error;
    }
  })
);

router.put(
  "/:bookId/note",
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = z.object({ bookId: z.string().min(1) }).parse(req.params);
    const payload = noteInputSchema.parse(req.body);

    const viewer = req.user;
    if (!viewer) {
      throw new HttpError(401, "Authentication required");
    }

    const book = await findBookById(params.bookId);
    if (!book) {
      throw new HttpError(404, "Book not found");
    }

    try {
      const saved = await prisma.bookNote.upsert({
        where: {
          bookId_userId: {
            bookId: params.bookId,
            userId: viewer.id
          }
        },
        update: {
          content: payload.content
        },
        create: {
          bookId: params.bookId,
          userId: viewer.id,
          content: payload.content
        }
      });

      await createAuditLog({
        actorUserId: viewer.id,
        action: "BOOK_NOTE_SAVED",
        entity: "BOOK_NOTE",
        entityId: saved.id,
        metadata: {
          bookId: params.bookId
        }
      });

      res.status(200).json({
        data: saved
      });
    } catch (error) {
      if (isMissingTableError(error)) {
        throw new HttpError(503, "Book notes are not initialized yet. Run database sync.");
      }
      throw error;
    }
  })
);

router.get(
  "/:bookId",
  asyncHandler(async (req, res) => {
    const params = z.object({ bookId: z.string().min(1) }).parse(req.params);
    const book = await findBookById(params.bookId);
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
