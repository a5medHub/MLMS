import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/errors";

export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      error: {
        message: error.message,
        details: error.details
      }
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.error(error);
  res.status(500).json({
    error: {
      message: "Internal server error"
    }
  });
};
