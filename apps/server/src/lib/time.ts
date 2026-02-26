const durationRegex = /^(\d+)([mhd])$/i;

export const durationToMs = (duration: string): number => {
  const match = durationRegex.exec(duration.trim());
  if (!match) {
    throw new Error(`Unsupported duration: ${duration}`);
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();

  if (unit === "m") {
    return value * 60 * 1000;
  }
  if (unit === "h") {
    return value * 60 * 60 * 1000;
  }
  return value * 24 * 60 * 60 * 1000;
};
