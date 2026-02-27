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

const resolveUserFromToken = async (
  token: string
): Promise<{
  id: string;
  role: "ADMIN" | "MEMBER";
  email: string;
  name: string;
  contactEmail: string | null;
  phoneNumber: string | null;
  personalId: string | null;
  readingPoints: number;
  avatarPreset: string | null;
  backgroundPreset: string | null;
}> => {
  const payload = verifyAccessToken(token);
  if (payload.typ !== "access") {
    throw new HttpError(401, "Invalid access token type");
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      role: true,
      email: true,
      name: true,
      contactEmail: true,
      phoneNumber: true,
      personalId: true,
      readingPoints: true,
      avatarPreset: true,
      backgroundPreset: true
    }
  });

  if (!user) {
    throw new HttpError(401, "User no longer exists");
  }

  return user;
};

export const requireAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const token = readAccessToken(req);
  if (!token) {
    next(new HttpError(401, "Missing bearer token"));
    return;
  }

  try {
    const user = await resolveUserFromToken(token);
    req.user = user;
    next();
  } catch (error) {
    next(new HttpError(401, "Invalid or expired access token", error));
  }
};

export const optionalAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const token = readAccessToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    const user = await resolveUserFromToken(token);
    req.user = user;
  } catch {
    req.user = undefined;
  }

  next();
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
