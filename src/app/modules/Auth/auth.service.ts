import { UserStatus } from "@prisma/client";
import * as crypto from "crypto";
import httpStatus from "http-status";
import { Secret } from "jsonwebtoken";
import config from "../../../config";
import { emailQueue } from "../../../config/queue";
import redisClient from "../../../config/redis";
import { otpEmail } from "../../../emails/otpEmail";
import ApiError from "../../../errors/ApiErrors";
import { jwtHelpers } from "../../../utils/jwtHelpers";
import { comparePassword, hashPassword } from "../../../utils/passwordHelpers";
import { AuthRepository } from "./auth.repository";

// ── HELPERS ───────────────────────────────────────────────────

const generateSecureOTP = (): string => {
  return crypto.randomInt(100000, 999999).toString();
};

const isOTPValid = (inputOTP: string, storedOTP: string): boolean => {
  if (inputOTP.length !== storedOTP.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(inputOTP),
    Buffer.from(storedOTP)
  );
};



const storeOTPInRedis = async (email: string, otp: string): Promise<void> => {
  const key = `otp:${email}`;
  await redisClient.set(key, otp, "EX", 300); 
};

const getOTPFromRedis = async (email: string): Promise<string | null> => {
  return redisClient.get(`otp:${email}`);
};

const deleteOTPFromRedis = async (email: string): Promise<void> => {
  await redisClient.del(`otp:${email}`);
};

// ── AUTH SERVICES ─────────────────────────────────────────────

const verifyUserByOTP = async (email: string, otp: string) => {
  const user = await AuthRepository.findUserByEmail(email);

  if (!user) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Invalid OTP or email.");
  }

  const storedOTP = await getOTPFromRedis(email);

  if (!storedOTP) {
    throw new ApiError(httpStatus.BAD_REQUEST, "OTP has expired.");
  }

  if (!isOTPValid(otp, storedOTP)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Invalid OTP or email.");
  }

  await Promise.all([
    AuthRepository.verifyUser(user.id),
    deleteOTPFromRedis(email),
  ]);

  const accessToken = jwtHelpers.generateToken(
    { id: user.id, email: user.email, role: user.role },
    config.jwt.jwt_secret as Secret,
    config.jwt.expires_in as string
  );

  const refreshToken = jwtHelpers.generateToken(
    { id: user.id, email: user.email, role: user.role },
    config.jwt.refresh_token_secret as Secret,
    config.jwt.refresh_token_expires_in as string
  );

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); 
  await AuthRepository.createSession({
    userId: user.id,
    refreshToken,
    expiresAt,
  });

  return { accessToken, refreshToken };
};

const refreshToken = async (token: string) => {
  const decodedToken = jwtHelpers.verifyToken(
    token,
    config.jwt.refresh_token_secret as Secret
  );

  if (!decodedToken) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid token");
  }

  
  const session = await AuthRepository.findSessionByRefreshToken(token);

  if (!session) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Session not found or expired");
  }

 
  if (session.expiresAt < new Date()) {
    await AuthRepository.deleteSession(session.id);
    throw new ApiError(httpStatus.UNAUTHORIZED, "Session expired. Please login again.");
  }

  const { user } = session;

  const accessToken = jwtHelpers.generateToken(
    { id: user.id, email: user.email, role: user.role },
    config.jwt.jwt_secret as Secret,
    config.jwt.expires_in as string
  );

  return { accessToken };
};

const loginUser = async (email: string, password: string) => {
  const userData = await AuthRepository.findUserByEmail(email);

  if (!userData) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid email or password.");
  }

  if (userData.status === UserStatus.DELETED) {
    throw new ApiError(403, "Your account has been deleted.");
  }

  if (!password || !userData?.password) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Password is required");
  }

  const isCorrectPassword = await comparePassword(password, userData.password);

  if (!isCorrectPassword) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid email or password.");
  }


  if (userData.isVerified === false) {
    const randomOtp = generateSecureOTP();


    await storeOTPInRedis(userData.email, randomOtp);


    await emailQueue.add("send-otp", {
      subject: "Verify Your Account",
      to: userData.email,
      html: otpEmail(randomOtp),
    });

    return {
      data: { id: userData.id, email: userData.email, role: userData.role },
      message: "Please verify your email with the OTP sent to your email address.",
    };
  }

  const accessToken = jwtHelpers.generateToken(
    { id: userData.id, email: userData.email, role: userData.role },
    config.jwt.jwt_secret as Secret,
    config.jwt.expires_in as string
  );

  const refreshToken = jwtHelpers.generateToken(
    { id: userData.id, email: userData.email, role: userData.role },
    config.jwt.refresh_token_secret as Secret,
    config.jwt.refresh_token_expires_in as string
  );


  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await AuthRepository.createSession({
    userId: userData.id,
    refreshToken,
    expiresAt,
  });

  return {
    data: { accessToken, refreshToken },
    message: "Login successful",
  };
};

const getMyProfile = async (email: string) => {
  if (!email) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Unauthorized");
  }

  const userProfile = await AuthRepository.findUserProfileByEmail(email);

  if (!userProfile) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found");
  }

  return userProfile;
};

const forgetPassword = async (email: string) => {
  const user = await AuthRepository.findUserByEmail(email);

  if (!user) return;

  const randomOtp = generateSecureOTP();


  await storeOTPInRedis(email, randomOtp);


  await emailQueue.add("send-reset-otp", {
    subject: "Password Reset OTP",
    to: user.email,
    html: otpEmail(randomOtp),
  });
};

const resetPassword = async (email: string, password: string) => {
  const user = await AuthRepository.findUserByEmail(email);

  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found");
  }

  if (password.length < 8) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Password must be at least 8 characters"
    );
  }

  const hashedPassword = await hashPassword(password);


  await Promise.all([
    AuthRepository.updateUserPassword(user.id, hashedPassword),
    AuthRepository.deleteAllUserSessions(user.id),
  ]);
};

const logOutUser = async (userId: string, refreshToken: string) => {

  const session = await AuthRepository.findSessionByRefreshToken(refreshToken);

  if (session) {
    await AuthRepository.deleteSession(session.id);
  }
};

export const AuthServices = {
  verifyUserByOTP,
  refreshToken,
  loginUser,
  logOutUser,
  getMyProfile,
  forgetPassword,
  resetPassword,
};
