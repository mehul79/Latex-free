import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readConfig } from "./config.js";
import { createAuth } from "./auth.js";
import { createApp } from "./app.js";
const config = readConfig();
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
});
await prisma.$connect();
const server = createApp(prisma, createAuth(prisma, config), config).listen(
  config.PORT,
  "0.0.0.0",
  () => console.log(`API listening on port ${config.PORT}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
  });
