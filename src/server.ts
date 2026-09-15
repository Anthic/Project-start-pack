import { Server } from "http";
import app from "./app";
import config from "./config";
import logger from "./utils/logger";
import emailWorker from "./workers/emailWorker";

let server: Server;


//shutdown function
const gracefulShutdown = async (signal: string) => {
  logger.warn(`${signal} received. Starting graceful shutdown...`);
  try {
    
    await emailWorker.close();
    logger.info("Email worker closed successfully.");
   
    if (server) {
      server.close(() => {
        logger.info(`${signal} received. HTTP server closed successfully.`);
        process.exit(0);
      });
      setTimeout(() => {
        logger.error("Forced shutdown after 10s timeout.");
        process.exit(1);
      }, 10_000);
    } else {
      process.exit(0);
    }
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
