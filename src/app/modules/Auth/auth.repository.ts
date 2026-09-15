import prisma from "../../../shared/prisma";

// ── USER QUERIES ──────────────────────────────────────────────

const findUserByEmail = (email: string) => {
  return prisma.user.findUnique({
    where: { email },
  });
};

const findUserById = (id: string) => {
  return prisma.user.findUnique({
    where: { id },
  });
};

const findUserProfileByEmail = (email: string) => {
  return prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      image: true,
      email: true,
      role: true,
      isVerified: true,
      privacyPolicyAccepted: true,
      phoneNumber: true,
      dateOfBirth: true,
      address: true,
      createdAt: true,
      updatedAt: true,
      status: true,
    },
  });
};

const updateUserOTP = (
  userId: string,
  otp: string | null,
  otpExpiresAt: Date | null
) => {
  return prisma.user.update({
    where: { id: userId },
    data: { otp, otpExpiresAt },
  });
};

const verifyUser = (userId: string) => {
  return prisma.user.update({
    where: { id: userId },
    data: {
      isVerified: true,
      otp: null,
      otpExpiresAt: null,
    },
  });
};

const updateUserPassword = (userId: string, hashedPassword: string) => {
  return prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  });
};

// ── SESSION QUERIES ───────────────────────────────────────────

const createSession = (data: {
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  userAgent?: string;
  ipAddress?: string;
}) => {
  return prisma.session.create({ data });
};

const findSessionByRefreshToken = (refreshToken: string) => {
  return prisma.session.findUnique({
    where: { refreshToken },
    include: { user: true }, 
  });
};

const deleteSession = (sessionId: string) => {
  return prisma.session.delete({
    where: { id: sessionId },
  });
};

const deleteAllUserSessions = (userId: string) => {
  return prisma.session.deleteMany({
    where: { userId },
  });
};

const updateSessionToken = (sessionId: string, newRefreshToken: string) => {
  return prisma.session.update({
    where: { id: sessionId },
    data: { refreshToken: newRefreshToken },
  });
};

export const AuthRepository = {
  // User
  findUserByEmail,
  findUserById,
  findUserProfileByEmail,
  updateUserOTP,
  verifyUser,
  updateUserPassword,
  // Session
  createSession,
  findSessionByRefreshToken,
  deleteSession,
  deleteAllUserSessions,
  updateSessionToken,
};
