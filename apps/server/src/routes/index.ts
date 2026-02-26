import { Router } from "express";
import { aiRouter } from "./ai.routes";
import { authRouter } from "./auth.routes";
import { booksRouter } from "./books.routes";
import { loansRouter } from "./loans.routes";
import { searchRouter } from "./search.routes";
import { usersRouter } from "./users.routes";

const router = Router();

router.use("/auth", authRouter);
router.use("/books", booksRouter);
router.use("/loans", loansRouter);
router.use("/users", usersRouter);
router.use("/search", searchRouter);
router.use("/ai", aiRouter);

export const apiRouter = router;
