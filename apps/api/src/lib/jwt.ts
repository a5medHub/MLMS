import jwt, { type JwtPayload, type Secret, type SignOptions } from "jsonwebtoken";
import { env } from "../config/env";

type AccessPayload = {
  sub: string;
  role: "ADMIN" | "MEMBER";
  typ: "access";
};

type RefreshPayload = {
  sub: string;
  jti: string;
  typ: "refresh";
};

const signJwt = <TPayload extends object>(
  payload: TPayload,
  secret: Secret,
  expiresIn: SignOptions["expiresIn"]
): string => {
  const options: SignOptions = { expiresIn };
  return jwt.sign(payload, secret, options);
};

export const signAccessToken = (userId: string, role: "ADMIN" | "MEMBER"): string => {
  const payload: AccessPayload = { sub: userId, role, typ: "access" };
  return signJwt(payload, env.JWT_ACCESS_SECRET, env.JWT_ACCESS_EXPIRES_IN as SignOptions["expiresIn"]);
};

export const signRefreshToken = (userId: string, jti: string): string => {
  const payload: RefreshPayload = { sub: userId, jti, typ: "refresh" };
  return signJwt(payload, env.JWT_REFRESH_SECRET, env.JWT_REFRESH_EXPIRES_IN as SignOptions["expiresIn"]);
};

export const verifyAccessToken = (token: string): AccessPayload & JwtPayload => {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload & JwtPayload;
};

export const verifyRefreshToken = (token: string): RefreshPayload & JwtPayload => {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshPayload & JwtPayload;
};
