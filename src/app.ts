import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Application, NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import path from "path";
import GlobalErrorHandler from "./app/middlewares/globalErrorHandler";
// import { PaymentController } from "./app/modules/Payment/payment.controller";
import router from "./app/routes";
import logger from "./utils/logger";
import helmet from "helmet";
import redisClient from "./config/redis";
import prisma from "./shared/prisma";
import swaggerUi from "swagger-ui-express";
import { swaggerDocs } from "./config/swagger";
import { requestIdMiddleware } from "./app/middlewares/requestId";

const app: Application = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3000", "http://localhost:3001"];


export const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

// app.post(
//   "/webhook",
//   express.raw({ type: "application/json" }),
//   PaymentController.stripeWebhook
// );

// Middleware setup
app.use(helmet());
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// Route handler for the root endpoint
app.get("/", (req: Request, res: Response) => {
  res.send({
    message: "Welcome to the API",
  });
});

// app.use("/uploads", express.static(path.join("/var/www/uploads")));
app.use("/uploads", express.static(path.join(process.cwd(), "uploads"))); // Serve static files from the "uploads" directory

// Correlation ID middleware
app.use(requestIdMiddleware);

// Log incoming requests
app.use((req: Request, res: Response, next: NextFunction) => {
  logger.info(`Incoming request: ${req.method} ${req.originalUrl}`, {
    requestId: req.requestId,
  });
  next();
});

// Setup API routes
app.use("/api/v1", router);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));
// health check
app.get("/health", async (req, res) => {
  try {
    const dbCheck = await prisma.$queryRaw`SELECT 1`
      .then(() => "healthy")
      .catch(() => "unhealthy");

    const redisCheck = await redisClient.ping()
      .then((pong) => (pong === "PONG" ? "healthy" : "unhealthy"))
      .catch(() => "unhealthy");

    const isHealthy = dbCheck === "healthy" && redisCheck === "healthy";

    res.status(isHealthy ? 200 : 503).json({
      success: isHealthy,
      message: isHealthy ? "System is fully operational" : "System is degraded",
      timestamp: new Date().toISOString(),
      uptime: `${Math.floor(process.uptime())}s`,
      services: {
        database: dbCheck,
        redis: redisCheck,
      },
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      message: "Health check failed",
    });
  }
});

// Error handling middleware
app.use(GlobalErrorHandler);

// 404 Not Found handler
app.use((req: Request, res: Response) => {
  res.status(httpStatus.NOT_FOUND).json({
    success: false,
    message: "Route not found",
    error: { path: req.originalUrl },
  });
});
export default app;
