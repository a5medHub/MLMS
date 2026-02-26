import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.get(
  "/books",
  requireAuth,
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        q: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(30).default(10)
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

    res.status(200).json({ data: books });
  })
);

export const searchRouter = router;
