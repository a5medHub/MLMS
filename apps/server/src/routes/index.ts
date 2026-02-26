import { Router } from "express";
import { aiRouter } from "./ai.routes";
import { authRouter } from "./auth.routes";
import { booksRouter } from "./books.routes";
import { loansRouter } from "./loans.routes";
import { searchRouter } from "./search.routes";
import { usersRouter } from "./users.routes";

const router = Router();

router.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok",
    message: "MLMS API v1",
    docs: {
      health: "/health",
      auth: "/api/v1/auth",
      books: "/api/v1/books",
      loans: "/api/v1/loans",
      users: "/api/v1/users",
      search: "/api/v1/search",
      ai: "/api/v1/ai"
    }
  });
});

router.use("/auth", authRouter);
router.use("/books", booksRouter);
router.use("/loans", loansRouter);
router.use("/users", usersRouter);
router.use("/search", searchRouter);
router.use("/ai", aiRouter);

export const apiRouter = router;
