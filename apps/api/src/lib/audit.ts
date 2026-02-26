import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";

type AuditInput = {
  actorUserId?: string;
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
};

export const createAuditLog = async (input: AuditInput): Promise<void> => {
  await prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      metadata: input.metadata
    }
  });
};
