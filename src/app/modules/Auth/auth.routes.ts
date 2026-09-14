import { UserRole } from "@prisma/client";
import express from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import {
  loginLimiter,
  otpLimiter,
} from "../../middlewares/rateLimiter";
import { AuthController } from "./auth.controller";
import { authValidation } from "./auth.validation";

const router = express.Router();


router.post(
  "/login",
  loginLimiter,
  validateRequest(authValidation.loginValidationSchema),
  AuthController.loginUser
);


router.post(
  "/forgot-password",
  otpLimiter,
  validateRequest(authValidation.forgetPasswordValidationSchema),
  AuthController.forgetPassword
);


router.patch(
  "/reset-password",
  auth(),
  validateRequest(authValidation.resetPasswordValidationSchema),
  AuthController.resetPassword
);


router.patch(
  "/verify-otp",
  otpLimiter,
  validateRequest(authValidation.verifyOTPValidationSchema),
  AuthController.verifyUserByOTP
);


router.patch(
  "/logout",
  auth(UserRole.ADMIN, UserRole.USER),
  AuthController.logOutUser
);


router.get("/refresh-token", AuthController.refreshToken);


router.get(
  "/me",
  auth(UserRole.ADMIN, UserRole.USER),
  AuthController.getMyProfile
);

export const AuthRoutes = router;
