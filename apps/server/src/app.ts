import fs from "fs";
import path from "path";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { corsOrigins } from "./config/env";
import { errorHandler } from "./middleware/error-handler";
import { notFoundHandler } from "./middleware/not-found";
import { apiRouter } from "./routes";

export const app = express();

app.use(
  cors({
    origin: corsOrigins,
    credentials: true
  })
);
app.use(
  helmet({
    // Required for popup-based Google sign-in postMessage flow.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }
  })
);
app.use(morgan("combined"));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime()
  });
});

app.use("/api/v1", apiRouter);

const clientDistPath = path.resolve(__dirname, "../../client/dist");
const clientIndexPath = path.join(clientDistPath, "index.html");
const hasClientBuild = fs.existsSync(clientIndexPath);

if (hasClientBuild) {
  app.use(express.static(clientDistPath, { index: false }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path === "/health") {
      next();
      return;
    }

    res.sendFile(clientIndexPath, (error) => {
      if (error) {
        next(error);
      }
    });
  });
}

app.use(notFoundHandler);
app.use(errorHandler);
