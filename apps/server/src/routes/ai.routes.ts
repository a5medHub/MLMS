import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { FALLBACK_BOOKS } from "../lib/fallback-books";
import { estimateLoanDueDate } from "../lib/reading-time";
import { optionalAuth, requireAuth } from "../middleware/auth";

const router = Router();
const RECOMMENDATIONS_CACHE_TTL_MS = 20_000;

type RecommendationsPayload = {
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
    recommendationScore: number;
  }>;
  meta: {
    strategy: string;
    sourceLoans: number;
  };
};

const recommendationsCache = new Map<string, { expiresAt: number; payload: RecommendationsPayload }>();

const isMissingColumnError = (error: unknown): boolean => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2022"
  );
};

router.post(
  "/due-date-estimate",
  requireAuth,
  asyncHandler(async (req, res) => {
    const payload = z
      .object({
        title: z.string().min(1),
        author: z.string().min(1),
        isbn: z.string().optional().nullable()
      })
      .parse(req.body);

    const estimate = await estimateLoanDueDate({
      title: payload.title,
      author: payload.author,
      isbn: payload.isbn
    });

    res.status(200).json({
      data: {
        dueAt: estimate.dueAt,
        days: estimate.days
      },
      meta: {
        source: estimate.source,
        pageCount: estimate.pageCount
      }
    });
  })
);

router.post(
  "/recommendations",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const payload = z
      .object({
        limit: z.coerce.number().int().min(1).max(20).default(5)
      })
      .parse(req.body ?? {});
    const viewer = req.user;
    const history = viewer
      ? await prisma.loan.findMany({
          where: { userId: viewer.id },
          select: {
            id: true,
            bookId: true,
            checkedOutAt: true,
            book: {
              select: {
                id: true,
                title: true,
                author: true,
                genre: true
              }
            }
          },
          orderBy: { checkedOutAt: "desc" },
          take: 40
        })
      : [];

    const cacheKey = `${viewer?.id ?? "guest"}:${payload.limit}:${history.length}`;
    const cached = recommendationsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.status(200).json(cached.payload);
      return;
    }

    const genreWeights = new Map<string, number>();
    const authorWeights = new Map<string, number>();
    const borrowedBookIds = new Set<string>();

    history.forEach((loan, index) => {
      const recencyWeight = Math.max(1, 5 - Math.floor(index / 8));
      borrowedBookIds.add(loan.bookId);

      if (loan.book.genre) {
        genreWeights.set(loan.book.genre, (genreWeights.get(loan.book.genre) ?? 0) + recencyWeight);
      }
      authorWeights.set(loan.book.author, (authorWeights.get(loan.book.author) ?? 0) + recencyWeight);
    });

    const runPrimaryCandidatesQuery = async () => {
      return prisma.book.findMany({
        where: {
          available: true,
          requestPending: false,
          ...(borrowedBookIds.size > 0 ? { id: { notIn: [...borrowedBookIds] } } : {})
        },
        take: 200
      });
    };

    const runLegacyCandidatesQuery = async () => {
      const legacy = await prisma.book.findMany({
        where: {
          available: true,
          ...(borrowedBookIds.size > 0 ? { id: { notIn: [...borrowedBookIds] } } : {})
        },
        take: 200,
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
      return legacy.map((book) => ({
        ...book,
        averageRating: null,
        ratingsCount: null,
        aiMetadata: false,
        requestPending: false
      }));
    };

    let candidates: Awaited<ReturnType<typeof runPrimaryCandidatesQuery>>;
    try {
      candidates = await runPrimaryCandidatesQuery();
    } catch (error) {
      if (isMissingColumnError(error)) {
        candidates = await runLegacyCandidatesQuery();
      } else {
        const fallbackPayload: RecommendationsPayload = {
          data: FALLBACK_BOOKS.slice(0, payload.limit).map((book, index) => ({
            ...book,
            recommendationScore: Number((1 - index * 0.01).toFixed(2))
          })),
          meta: {
            strategy: "fallback-curated-list",
            sourceLoans: history.length
          }
        };
        res.status(200).json(fallbackPayload);
        return;
      }
    }

    const scored = candidates
      .map((book) => {
        const genreScore = book.genre ? genreWeights.get(book.genre) ?? 0 : 0;
        const authorScore = authorWeights.get(book.author) ?? 0;
        const noveltyBonus = history.length === 0 ? 2 : 0;
        const ratingBoost = (book.averageRating ?? 0) * 1.5;
        const ratingVolumeBoost = Math.min(2, Math.log10((book.ratingsCount ?? 0) + 1));
        const availabilityBoost = book.available ? 1 : 0;
        const score = genreScore * 1.2 + authorScore * 1.4 + noveltyBonus + ratingBoost + ratingVolumeBoost + availabilityBoost;
        return {
          ...book,
          recommendationScore: Number(score.toFixed(2))
        };
      })
      .sort((a, b) => b.recommendationScore - a.recommendationScore)
      .slice(0, payload.limit);

    const responsePayload: RecommendationsPayload = {
      data: scored,
      meta: {
        strategy:
          history.length > 0
            ? "history-weighted genre/author affinity with rating boost"
            : "top-rated available books",
        sourceLoans: history.length
      }
    };

    recommendationsCache.set(cacheKey, {
      expiresAt: Date.now() + RECOMMENDATIONS_CACHE_TTL_MS,
      payload: responsePayload
    });

    res.status(200).json(responsePayload);
  })
);

export const aiRouter = router;
