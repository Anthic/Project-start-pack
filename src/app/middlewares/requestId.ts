import { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export const requestId = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {

  const id = (req.headers["x-request-id"] as string) || randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-ID", id);

  next();
};