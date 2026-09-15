import { UserRole, UserStatus } from "@prisma/client";
import httpStatus from "http-status";
import { Secret } from "jsonwebtoken";
import config from "../../../config";
import { otpEmail } from "../../../emails/otpEmail";
import ApiError from "../../../errors/ApiErrors";
import emailSender from "../../../helpars/emailSender/emailSender";
import stripe from "../../../helpars/stripe/stripe";
import { IPaginationOptions } from "../../../interfaces/paginations";
import prisma from "../../../shared/prisma";
import { jwtHelpers } from "../../../utils/jwtHelpers";
import { paginationHelpers } from "../../../utils/paginationHelper";
import { hashPassword } from "../../../utils/passwordHelpers";
import { TSocialUser, TUser } from "./user.interface";
import * as crypto from "crypto";

const generateSecureOTP = (): string => {
  return crypto.randomInt(100000, 999999).toString();
};

const createUser = async (payload: TUser) => {
  if (!payload?.password) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Password is required");
  }

  if (payload.password.length < 8) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "Password must be at least 8 characters long"
    );
  }

   if (!payload.privacyPolicyAccepted) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "You must accept the privacy policy to register"
    );
  }

  const isUser = await prisma.user.findUnique({
    where: {
      email: payload.email,
    },
  });

  if (isUser) {
    throw new ApiError(httpStatus.BAD_REQUEST, "User already exists");
  }

  const hashedPassword = await hashPassword(payload.password);
  const randomOtp = generateSecureOTP()
  const otpExpiry = new Date(Date.now() + 5 * 60 * 1000);

  const customer = await stripe.customers.create({
    email: payload.email,
    metadata: { email: payload.email },
  });

  if (!customer.id) {
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Failed to create customer"
    );
  }

  const user = await prisma.user.create({
    data: {
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      password: hashedPassword,
      role: UserRole.USER,
      otp: randomOtp,
      otpExpiresAt: otpExpiry,
      privacyPolicyAccepted: payload.privacyPolicyAccepted,
      stripeCustomerId: customer.id,
    },
  });

  await emailSender("Verify Your Account", user.email, otpEmail(randomOtp));


  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
  };
};

const createSocialUser = async (payload: TSocialUser) => {
  const isUser = await prisma.user.findUnique({
    where: { email: payload.email },
  });

  if (isUser) {
    if (isUser.status === UserStatus.DELETED) {
      throw new ApiError(httpStatus.FORBIDDEN, "Your account is deleted");
    }

    const accessToken = jwtHelpers.generateToken(
      {
        id: isUser.id,
        email: isUser.email,
        role: isUser.role,
      },
      config.jwt.jwt_secret as Secret,
      config.jwt.expires_in as string
    );

    const refreshToken = jwtHelpers.generateToken(
      {
        id: isUser.id,
        email: isUser.email,
        role: isUser.role,
      },
      config.jwt.refresh_token_secret as Secret,
      config.jwt.refresh_token_expires_in as string
    );

    await prisma.session.create({
      data: {
        userId: isUser.id,
        refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: isUser.id,
        firstName: isUser.firstName,
        lastName: isUser.lastName,
        email: isUser.email,
        role: isUser.role,
        image: isUser.image,
      },
    };
  }

  const nameParts = payload.name.split(" ");
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(" ") || undefined;

  const customer = await stripe.customers.create({
    email: payload.email,
    metadata: { email: payload.email },
  });

  if (!customer.id) {
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Failed to create customer"
    );
  }

  const user = await prisma.user.create({
    data: {
      firstName: firstName,
      lastName: lastName,
      email: payload.email,
      image: payload.image,
      role: UserRole.USER,
      isVerified: true,
      provider: payload.provider,
      privacyPolicyAccepted: true,
      stripeCustomerId: customer.id,
    },
  });

  const accessToken = jwtHelpers.generateToken(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    config.jwt.jwt_secret as Secret,
    config.jwt.expires_in as string
  );

  const refreshToken = jwtHelpers.generateToken(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    config.jwt.refresh_token_secret as Secret,
    config.jwt.refresh_token_expires_in as string
  );

  await prisma.session.create({
    data: {
      userId: user.id,
      refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      image: user.image,
    },
  };
};

const updateUser = async (payload: Partial<TUser>, userId: string) => {
  if (!userId) {
    throw new ApiError(httpStatus.BAD_REQUEST, "User ID is required");
  }


  const safeUpdateData = {
    firstName: payload.firstName,
    lastName: payload.lastName,
    phoneNumber: payload.phoneNumber,
    dateOfBirth: payload.dateOfBirth,
    address: payload.address,
    image: payload.image,
  };


  const filteredData = Object.fromEntries(
    Object.entries(safeUpdateData).filter(([_, v]) => v !== undefined)
  );

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: filteredData,
  });

  return {
    id: updatedUser.id,
    firstName: updatedUser.firstName,
    lastName: updatedUser.lastName,
    email: updatedUser.email,
    role: updatedUser.role,
    image: updatedUser.image,
    phoneNumber: updatedUser.phoneNumber,
    dateOfBirth: updatedUser.dateOfBirth,
    address: updatedUser.address,
  };
};

const allUsers = async (
  filters: {
    searchTerm?: string;
  },
  options: IPaginationOptions
) => {
  const { limit, page, skip, sortBy, sortOrder } =
    paginationHelpers.calculatePagination(options);
  const { searchTerm } = filters;

  const andConditions: any[] = [];

  if (searchTerm) {
    andConditions.push({
      OR: [
        { firstName: { contains: searchTerm, mode: "insensitive" } },
        { lastName: { contains: searchTerm, mode: "insensitive" } },
        { email: { contains: searchTerm, mode: "insensitive" } },
      ],
    });
  }

  const whereConditions =
    andConditions.length > 0 ? { AND: andConditions } : {};

   const [users, total] = await prisma.$transaction([
    prisma.user.findMany({
      where: {
        ...whereConditions,
        role: UserRole.USER,
        status: { not: UserStatus.DELETED },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        image: true,
        phoneNumber: true,
        createdAt: true,
        updatedAt: true,
        isVerified: true,
        status: true,
      },
      skip,
      take: limit,
      orderBy:
        sortBy && sortOrder ? { [sortBy]: sortOrder } : { createdAt: "desc" },
    }),
    prisma.user.count({
      where: {
        ...whereConditions,
        role: UserRole.USER,
        status: { not: UserStatus.DELETED },
      },
    }),
  ]);

  return { meta: { page, limit, total }, data: users };
};

const updateStatus = async (userId: string, status: UserStatus) => {
  if (!userId) {
    throw new ApiError(httpStatus.BAD_REQUEST, "User ID is required");
  }
  const existingUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!existingUser) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found");
  }
  const user = await prisma.user.update({
    where: { id: userId },
    data: { status },
  });

  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    status: user.status,
  };
};

export const UserService = {
  createUser,
  createSocialUser,
  updateUser,
  allUsers,
  updateStatus,
};
