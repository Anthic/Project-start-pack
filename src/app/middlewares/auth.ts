import { NextFunction, Request, Response } from "express";

import httpStatus from "http-status";
import { Secret } from "jsonwebtoken";
import config from "../../config";
import ApiError from "../../errors/ApiErrors";
import prisma from "../../shared/prisma";
import { jwtHelpers } from "../../utils/jwtHelpers";

//  auth(UserRole.SUPER_ADMIN, UserRole.ADMIN)

const auth = (...roles: string[]) => {
  return async (
    req: Request & { user?: any },
    res: Response,
    next: NextFunction
  ) => {
    try {
      const token = req.headers.authorization;

      if (!token) {
        throw new ApiError(httpStatus.UNAUTHORIZED, "You are not authorized!");
      }

      const verifiedUser = jwtHelpers.verifyToken(
        token,
        config.jwt.jwt_secret as Secret
      );

      const user = await prisma.user.findUnique({
        where: {
          email: verifiedUser.email,
        },
        select : {
          id : true,
          email : true,
          role : true, 
          status : true
        }
      });

      if (!user) {
        throw new ApiError(httpStatus.NOT_FOUND, "This user is not found !");
      }

      if(user.status !== "ACTIVE"){
        throw new ApiError(httpStatus.FORBIDDEN , "Your account is not active!")
      }

      if(roles.length && !roles.includes(user.role)){
        throw new ApiError(httpStatus.FORBIDDEN , "Forbidden!")
      }

      req.user = verifiedUser;
      next();
    } catch (err) {
      next(err);
    }
  };
};

export default auth;
