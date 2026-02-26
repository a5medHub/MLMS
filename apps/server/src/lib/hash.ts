import { createHash } from "crypto";

export const hashToken = (value: string): string => {
  return createHash("sha256").update(value).digest("hex");
};
