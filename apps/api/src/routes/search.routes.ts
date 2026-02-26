import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { persistExternalBooks, searchExternalBooks } from "../lib/external-books";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.get(
  "/books",
  requireAuth,
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

    const books = await prisma.book.findMany({
      where: {
        OR: [
          { title: { contains: query.q, mode: "insensitive" } },
          { author: { contains: query.q, mode: "insensitive" } },
          { genre: { contains: query.q, mode: "insensitive" } },
          { isbn: { contains: query.q, mode: "insensitive" } }
        ]
      },
      take: query.limit,
      orderBy: [{ available: "desc" }, { title: "asc" }]
    });

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
