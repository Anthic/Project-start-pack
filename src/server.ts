import { Server } from "http";
import app from "./app";
import config from "./config";
import logger from "./utils/logger";
import emailWorker from "./workers/emailWorker";
import redisClient from "./config/redis";
import prisma from "./shared/prisma";

let server: Server;


//shutdown function
const gracefulShutdown = async (signal: string) => {
  logger.warn(`${signal} received. Starting graceful shutdown...`);
  try {
    
    await emailWorker.close();
    logger.info("Email worker closed successfully.");
   
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() =>{
          logger.info("HTTP server closed successfully")
          resolve()
        })
      })
    }
    await redisClient.quit()
    logger.info("Redis client closed successfully")
    await prisma.$disconnect()
    logger.info("Prisma client closed successfully")

    logger.info("Graceful shutdown complete. Bye!");
    process.exit(0)
  } catch (error) {
    logger.error("Error during graceful shutdown:", error);
    process.exit(1);
  }
};
// Main function to start the server
function main() {
  try {
    server = app.listen(config.port, () => {
      logger.info(`Server is running on port ${config.port}`);
      logger.info("Email worker started");
    });
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();


//for docker kubernates 
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
//ctrl + c come for terminal
process.on("SIGINT", () => gracefulShutdown("SIGINT"));


process.on("unhandledRejection", (err) => {
  logger.error("UnhandledRejection detected:", err);
  gracefulShutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  logger.error("UncaughtException detected:", err);
  process.exit(1);
});
