import "dotenv/config";
import { app } from "./app";
import { env } from "./config/env";
import { prisma } from "./db/prisma";

const start = async (): Promise<void> => {
  await prisma.$connect();

  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API running on http://localhost:${env.PORT}`);
  });
};

void start();

const gracefulShutdown = async (): Promise<void> => {
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => {
  void gracefulShutdown();
});
process.on("SIGTERM", () => {
  void gracefulShutdown();
});
