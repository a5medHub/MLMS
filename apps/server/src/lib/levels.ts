type LevelInfo = {
  levelNumber: number;
  levelName: string;
  totalPoints: number;
  levelFloor: number;
  levelCap: number;
  pointsIntoLevel: number;
  pointsNeededInLevel: number;
  progressPercent: number;
};

const baseLevelCap = 100;
const growthFactor = 1.5;
const levelNames = ["Noob", "Reader", "Pro", "King"];

const getLevelName = (levelNumber: number): string => {
  if (levelNumber <= levelNames.length) {
    return levelNames[levelNumber - 1];
  }
  return `Legend ${levelNumber}`;
};

export const getLevelInfo = (points: number): LevelInfo => {
  const safePoints = Math.max(0, Math.floor(points));
  let levelNumber = 1;
  let levelFloor = 0;
  let levelCap = baseLevelCap;

  while (safePoints >= levelCap) {
    levelNumber += 1;
    levelFloor = levelCap;
    levelCap += Math.round(baseLevelCap * Math.pow(growthFactor, levelNumber - 2));
  }

  const pointsIntoLevel = safePoints - levelFloor;
  const pointsNeededInLevel = Math.max(1, levelCap - levelFloor);
  const progressPercent = Math.max(0, Math.min(100, Math.round((pointsIntoLevel / pointsNeededInLevel) * 100)));

  return {
    levelNumber,
    levelName: getLevelName(levelNumber),
    totalPoints: safePoints,
    levelFloor,
    levelCap,
    pointsIntoLevel,
    pointsNeededInLevel,
    progressPercent
  };
};

