import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma";
import { HttpError } from "../lib/errors";
import { verifyAccessToken } from "../lib/jwt";

type UserRole = "ADMIN" | "MEMBER";

const readAccessToken = (req: Request): string | null => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return null;
  }
  return auth.replace("Bearer ", "");
};

export const requireAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const token = readAccessToken(req);
  if (!token) {
    next(new HttpError(401, "Missing bearer token"));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    if (payload.typ !== "access") {
      next(new HttpError(401, "Invalid access token type"));
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, email: true, name: true }
    });

    if (!user) {
      next(new HttpError(401, "User no longer exists"));
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    next(new HttpError(401, "Invalid or expired access token", error));
  }
};

export const requireRole = (roles: UserRole[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new HttpError(401, "Authentication required"));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new HttpError(403, "Insufficient permissions"));
      return;
    }
    next();
  };
};
