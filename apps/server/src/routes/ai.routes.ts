import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.post(
  "/recommendations",
  requireAuth,
  asyncHandler(async (req, res) => {
    const payload = z
      .object({
        limit: z.coerce.number().int().min(1).max(20).default(5)
      })
      .parse(req.body ?? {});
    const viewer = req.user!;

    const history = await prisma.loan.findMany({
      where: { userId: viewer.id },
      include: { book: true },
      orderBy: { checkedOutAt: "desc" },
      take: 40
    });

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

    const candidates = await prisma.book.findMany({
      where: {
        available: true,
        id: { notIn: [...borrowedBookIds] }
      },
      take: 100
    });

    const scored = candidates
      .map((book) => {
        const genreScore = book.genre ? genreWeights.get(book.genre) ?? 0 : 0;
        const authorScore = authorWeights.get(book.author) ?? 0;
        const noveltyBonus = history.length === 0 ? 2 : 0;
        const score = genreScore * 1.2 + authorScore * 1.4 + noveltyBonus;
        return {
          ...book,
          recommendationScore: Number(score.toFixed(2))
        };
      })
      .sort((a, b) => b.recommendationScore - a.recommendationScore)
      .slice(0, payload.limit);

    res.status(200).json({
      data: scored,
      meta: {
        strategy: "history-weighted genre/author affinity",
        sourceLoans: history.length
      }
    });
  })
);

export const aiRouter = router;
