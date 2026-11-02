import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readConfig } from "./config.js";
import { createAuth } from "./auth.js";
import { CollaborationService } from "./collaboration.js";
import { createApp } from "./app.js";
const config = readConfig();
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
});
await prisma.$connect();
const auth = createAuth(prisma, config);
const collaboration = new CollaborationService(prisma, auth, config);
const server = createApp(prisma, auth, config, collaboration).listen(
  config.PORT,
  "0.0.0.0",
  () => console.log(`API listening on port ${config.PORT}`),
);
collaboration.attach(server);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void collaboration.destroy().then(() =>
      server.close(() => {
        void prisma.$disconnect().then(() => process.exit(0));
      }),
    );
  });
