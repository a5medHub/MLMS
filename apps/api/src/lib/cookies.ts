import type { CookieOptions, Response } from "express";
import { cookieSecure, env } from "../config/env";

const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: cookieSecure || env.NODE_ENV === "production",
  sameSite: env.COOKIE_SAME_SITE
};

if (env.COOKIE_DOMAIN) {
  baseCookieOptions.domain = env.COOKIE_DOMAIN;
}

export const setRefreshCookie = (res: Response, value: string): void => {
  res.cookie("refresh_token", value, {
    ...baseCookieOptions,
    path: "/api/v1/auth",
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
};

export const clearRefreshCookie = (res: Response): void => {
  res.clearCookie("refresh_token", {
    ...baseCookieOptions,
    path: "/api/v1/auth"
  });
};
