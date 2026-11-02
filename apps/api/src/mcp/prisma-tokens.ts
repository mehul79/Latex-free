import type { PrismaClient } from "@prisma/client";
import { ApiError } from "../document-service.js";
import type { TokenStore } from "./contracts.js";

export function createPrismaTokenStore(prisma: PrismaClient): TokenStore {
  return {
    create: (record, activeLimit) =>
      prisma.$transaction(async (tx) => {
        // Serialize token issuance on the stable owner row so concurrent requests cannot exceed the cap.
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${record.userId} FOR UPDATE`;
        const count = await tx.accessToken.count({
          where: {
            userId: record.userId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        if (count >= activeLimit)
          throw new ApiError(
            409,
            "Revoke an existing token before creating another",
          );
        return tx.accessToken.create({ data: record });
      }),
    findByHash: (tokenHash) =>
      prisma.accessToken.findUnique({ where: { tokenHash } }),
    list: (userId) =>
      prisma.accessToken.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    revoke: async (userId, id) => {
      const result = await prisma.accessToken.updateMany({
        where: { id, userId },
        data: { revokedAt: new Date() },
      });
      return result.count > 0;
    },
  };
}
