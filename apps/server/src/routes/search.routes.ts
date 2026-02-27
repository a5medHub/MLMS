import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { persistExternalBooks, searchExternalBooks } from "../lib/external-books";
import { FALLBACK_BOOKS } from "../lib/fallback-books";
import { optionalAuth } from "../middleware/auth";

const router = Router();
const isMissingColumnError = (error: unknown): boolean => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2022"
  );
};

router.get(
  "/books",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        q: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(30).default(10),
        withFallback: z
          .union([z.boolean(), z.literal("true"), z.literal("false")])
          .optional()
          .transform((value) => value === true || value === "true")
      })
      .parse(req.query);

    const where = {
      OR: [
        { title: { contains: query.q, mode: "insensitive" as const } },
        { author: { contains: query.q, mode: "insensitive" as const } },
        { genre: { contains: query.q, mode: "insensitive" as const } },
        { isbn: { contains: query.q, mode: "insensitive" as const } }
      ]
    };

    let books: Array<{
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
      requestPending: boolean;
      createdAt: Date;
      updatedAt: Date;
    }>;
    try {
      books = await prisma.book.findMany({
        where,
        take: query.limit,
        orderBy: [{ available: "desc" }, { title: "asc" }]
      });
    } catch (error) {
      if (!isMissingColumnError(error)) {
        throw error;
      }
      const legacyBooks = await prisma.book.findMany({
        where,
        take: query.limit,
        orderBy: [{ available: "desc" }, { title: "asc" }],
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
      books = legacyBooks.map((book) => ({
        ...book,
        averageRating: null,
        ratingsCount: null,
        requestPending: false
      }));
    }

    if (books.length > 0 || !query.withFallback) {
      res.status(200).json({
        data: books,
        meta: {
          source: "local",
          fallbackUsed: false
        }
      });
      return;
    }

    if (!req.user && query.withFallback) {
      const fallback = FALLBACK_BOOKS.filter((book) => {
        const q = query.q.toLowerCase();
        return (
          book.title.toLowerCase().includes(q) ||
          book.author.toLowerCase().includes(q) ||
          (book.genre ?? "").toLowerCase().includes(q) ||
          (book.isbn ?? "").toLowerCase().includes(q)
        );
      }).slice(0, query.limit);
      if (fallback.length > 0) {
        res.status(200).json({
          data: fallback,
          meta: {
            source: "fallback",
            fallbackUsed: true
          }
        });
        return;
      }
    }

    if (!req.user) {
      res.status(200).json({
        data: [],
        meta: {
          source: "local",
          fallbackUsed: false
        }
      });
      return;
    }

    const externalResult = await searchExternalBooks(query.q, query.limit, "auto");
    if (externalResult.books.length === 0) {
      res.status(200).json({
        data: [],
        meta: {
          source: "none",
          fallbackUsed: externalResult.fallbackUsed
        }
      });
      return;
    }

    const persisted = await persistExternalBooks(externalResult.books);
    res.status(200).json({
      data: persisted.books,
      meta: {
        source: externalResult.sourceUsed,
        fallbackUsed: externalResult.fallbackUsed,
        importedCount: persisted.createdCount,
        existingCount: persisted.reusedCount
      }
    });
  })
);

export const searchRouter = router;
