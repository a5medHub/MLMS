import { randomUUID } from "crypto";
import { OAuth2Client } from "google-auth-library";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import { asyncHandler } from "../lib/async-handler";
import { clearRefreshCookie, setRefreshCookie } from "../lib/cookies";
import { HttpError } from "../lib/errors";
import { hashToken } from "../lib/hash";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../lib/jwt";
import { durationToMs } from "../lib/time";
import { requireAuth } from "../middleware/auth";

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);
const router = Router();

const loginSchema = z.object({
  credential: z.string().min(1)
});

const roleSchema = z.enum(["ADMIN", "MEMBER"]);

const getRefreshTokenFromRequest = (tokenFromCookie?: string, tokenFromBody?: string): string => {
  if (tokenFromCookie) {
    return tokenFromCookie;
  }
  if (tokenFromBody) {
    return tokenFromBody;
  }
  throw new HttpError(401, "Refresh token missing");
};

const createAuthPayload = async (user: {
  id: string;
  role: "ADMIN" | "MEMBER";
  email: string;
  name: string;
}) => {
  const accessToken = signAccessToken(user.id, user.role);
  const refreshJti = randomUUID();
  const refreshToken = signRefreshToken(user.id, refreshJti);
  const tokenHash = hashToken(refreshToken);
  const refreshTtlMs = durationToMs(env.JWT_REFRESH_EXPIRES_IN);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + refreshTtlMs)
    }
  });

  return { accessToken, refreshToken };
};

router.post(
  "/google",
  asyncHandler(async (req, res) => {
    const { credential } = loginSchema.parse(req.body);

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();

    if (!payload?.email || !payload.email_verified) {
      throw new HttpError(401, "Google account email must be verified");
    }

    const user = await prisma.user.upsert({
      where: { email: payload.email },
      update: {
        name: payload.name ?? payload.email,
        picture: payload.picture,
        googleSub: payload.sub
      },
      create: {
        email: payload.email,
        name: payload.name ?? payload.email,
        picture: payload.picture,
        googleSub: payload.sub
      },
      select: {
        id: true,
        role: true,
        email: true,
        name: true
      }
    });

    const authTokens = await createAuthPayload({
      id: user.id,
      role: roleSchema.parse(user.role),
      email: user.email,
      name: user.name
    });

    setRefreshCookie(res, authTokens.refreshToken);

    res.status(200).json({
      accessToken: authTokens.accessToken,
      user
    });
  })
);

router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const requestSchema = z.object({
      refreshToken: z.string().optional()
    });
    const { refreshToken: refreshTokenFromBody } = requestSchema.parse(req.body ?? {});
    const refreshToken = getRefreshTokenFromRequest(req.cookies.refresh_token, refreshTokenFromBody);
    const decoded = verifyRefreshToken(refreshToken);

    if (decoded.typ !== "refresh") {
      throw new HttpError(401, "Invalid refresh token type");
    }

    const hashed = hashToken(refreshToken);
    const dbToken = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashed },
      include: { user: true }
    });

    if (!dbToken || dbToken.revokedAt || dbToken.expiresAt < new Date()) {
      throw new HttpError(401, "Refresh token is revoked or expired");
    }

    await prisma.refreshToken.update({
      where: { id: dbToken.id },
      data: { revokedAt: new Date() }
    });

    const authTokens = await createAuthPayload({
      id: dbToken.user.id,
      role: roleSchema.parse(dbToken.user.role),
      email: dbToken.user.email,
      name: dbToken.user.name
    });

    setRefreshCookie(res, authTokens.refreshToken);

    res.status(200).json({
      accessToken: authTokens.accessToken
    });
  })
);

router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const refreshToken = req.cookies.refresh_token;
    if (refreshToken) {
      const hashed = hashToken(refreshToken);
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashed, revokedAt: null },
        data: { revokedAt: new Date() }
      });
    }
    clearRefreshCookie(res);
    res.status(200).json({ success: true });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.user) {
      throw new HttpError(401, "Authentication required");
    }

    res.status(200).json({ user: req.user });
  })
);

export const authRouter = router;
