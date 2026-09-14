# 📅 PHASE 3 — Architecture Upgrade
## (তুমি টাইপ করবে, আমি শেখাব)

---

## 🗺️ Phase 3 রোডম্যাপ

```
PHASE 3 — Architecture Upgrade:
├── STEP 18: Prisma schema — Sessions table (User থেকে token সরানো)
├── STEP 19: npm install (ioredis, bullmq)
├── STEP 20: src/config/redis.ts          ← নতুন ফাইল (Redis connection)
├── STEP 21: src/config/queue.ts          ← নতুন ফাইল (BullMQ queue)
├── STEP 22: src/workers/emailWorker.ts   ← নতুন ফাইল (email processor)
├── STEP 23: src/app/modules/Auth/auth.repository.ts  ← নতুন ফাইল (Repository Pattern)
├── STEP 24: src/app/modules/Auth/auth.service.ts     ← update (Redis OTP + BullMQ email)
└── STEP 25: src/server.ts               ← update (worker start করা)
```

---

## 🧠 Phase 3 এ কী শিখছি? (আগে বুঝো, তারপর code করো)

### ১. Sessions Table কেন?
এখন User table এই `accessToken`, `refreshToken` রাখা হচ্ছে।
**সমস্যা:**
- একজন user multiple device থেকে login করলে শুধু ১টা token থাকে (আগেরটা বাতিল)
- User table এ sensitive data — security risk
- Token revoke করতে পুরো user row update করতে হয়

**সমাধান:** আলাদা `sessions` table — user ↔ session = one-to-many

### ২. Repository Pattern কেন?
এখন auth.service.ts এ সরাসরি `prisma.user.findUnique(...)` লেখা আছে।
**সমস্যা:**
- Service logic আর DB query একসাথে মিশে আছে
- Test করতে DB দরকার হয়
- DB বদলাতে হলে সব service file বদলাতে হবে

**সমাধান:** Repository = DB এর সাথে কথা বলার আলাদা layer

### ৩. Redis OTP কেন?
এখন OTP User table এ রাখা হচ্ছে।
**সমস্যা:**
- OTP মাত্র ৫ মিনিটের জন্য, কিন্তু DB তে permanent row থাকছে
- OTP verify হলে manually `null` করতে হচ্ছে
- High traffic এ DB তে extra load

**সমাধান:** Redis = in-memory store, auto-expire করে দেয়

### ৪. BullMQ Email Queue কেন?
এখন email পাঠানো synchronous — user কে email পাঠানোর জন্য wait করতে হয়।
**সমস্যা:**
- Email server slow হলে API response slow হয়
- Email fail হলে user কে error দেখায়
- Retry logic নেই

**সমাধান:** Queue = email job background এ পাঠাও, API instantly respond করো

---

## 🗄️ STEP 18 — Prisma Schema Update

### ১৮ক: `prisma/schema.prisma` এ Sessions table যোগ করো

**বর্তমান User model এ আছে (এগুলো REMOVE করতে হবে):**
```
accessToken  String?
refreshToken String?
```

**পুরো `prisma/schema.prisma` ফাইলটা এভাবে replace করো:**

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum UserRole {
  USER
  ADMIN
}

enum UserStatus {
  ACTIVE
  SUSPENDED
  DELETED
}

model User {
  id String @id @default(cuid())

  firstName             String
  lastName              String?
  email                 String     @unique
  image                 String?
  password              String?
  privacyPolicyAccepted Boolean    @default(false)

  phoneNumber String?
  dateOfBirth DateTime?
  address     String?
  status      UserStatus @default(ACTIVE)

  role UserRole @default(USER)

  isVerified Boolean @default(false)

  stripeCustomerId String?
  provider         String?

  // ──────────────────────────────────────────────
  // accessToken আর refreshToken এখানে নেই!
  // কারণ: এগুলো এখন Sessions table এ থাকবে।
  // User ↔ Session = one-to-many (multiple device support)
  // ──────────────────────────────────────────────
  sessions Session[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("users")
}

// ──────────────────────────────────────────────────────────────
// SESSION TABLE
//
// কেন আলাদা table?
// → একজন user ফোন + laptop + tablet থেকে login করতে পারবে
// → প্রতিটা device এর জন্য আলাদা session থাকবে
// → logout করলে শুধু ঐ device এর session delete হবে
// → Admin চাইলে specific session বা সব session revoke করতে পারবে
// ──────────────────────────────────────────────────────────────
model Session {
  id String @id @default(cuid())

  // কোন user এর session?
  userId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  // refresh token এখানে থাকবে
  refreshToken String @unique

  // কোন device/browser থেকে login করেছে (optional but useful)
  userAgent String?
  ipAddress String?

  // কতক্ষণ valid?
  expiresAt DateTime

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("sessions")
}

model Test {
  id String @id @default(cuid())

  name String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("tests")
}
```

### ১৮খ: Migration রান করো

Schema লেখা হলে Terminal এ:
```bash
npx prisma migrate dev --name add-sessions-table
```

তারপর Prisma Client regenerate হবে automatically।

**বলো যখন migration সফল হয় — STEP 19 তে যাব।**

---

## 📦 STEP 19 — Package Install

```bash
npm install ioredis bullmq
```

**কী কী install হচ্ছে?**
- `ioredis` → Redis এর সাথে কথা বলার library (official redis client এর চেয়ে ভালো)
- `bullmq` → Job queue library — background task manage করে (built on top of Redis)

---

## 🔌 STEP 20 — `src/config/redis.ts` (নতুন ফাইল)

**`src/config/` ফোল্ডারে `redis.ts` নামে নতুন ফাইল বানাও:**

```typescript
import Redis from "ioredis";
import logger from "../utils/logger";

// ─────────────────────────────────────────────────────────────
// REDIS CONNECTION
//
// Redis কী?
// → In-memory key-value store
// → DB এর মতো, কিন্তু RAM এ থাকে — অনেক দ্রুত
// → OTP, session cache, rate limit counter, job queue সব এখানে রাখা যায়
//
// কেন singleton pattern?
// → একটা project এ একটাই Redis connection যথেষ্ট
// → বারবার connect করলে resource waste হয়
// ─────────────────────────────────────────────────────────────

const redisClient = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  // connection fail হলে কতবার retry করবে
  maxRetriesPerRequest: null, // BullMQ এর জন্য null দিতে হয়
  retryStrategy: (times) => {
    // প্রতি retry এর মধ্যে delay বাড়বে (exponential backoff)
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redisClient.on("connect", () => {
  logger.info("✅ Redis connected successfully");
});

redisClient.on("error", (err) => {
  logger.error("❌ Redis connection error:", err);
});

export default redisClient;
```

**`.env` তে যোগ করো:**
```env
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
# REDIS_PASSWORD=  ← local dev এ দরকার নেই
```

**বলো যখন শেষ — STEP 21 তে যাব।**

---

## 📬 STEP 21 — `src/config/queue.ts` (নতুন ফাইল)

**`src/config/` ফোল্ডারে `queue.ts` নামে নতুন ফাইল বানাও:**

```typescript
import { Queue } from "bullmq";
import redisClient from "./redis";

// ─────────────────────────────────────────────────────────────
// EMAIL QUEUE
//
// Queue কী?
// → Job গুলো একটা list এ রাখে
// → Worker সেই list থেকে নিয়ে একটা একটা করে process করে
// → Job fail হলে automatically retry করে
//
// Real life analogy:
// → Restaurant এ order দিলে কিচেনে চলে যায়
// → তুমি অন্য কাজ করতে পারো, খাবার ready হলে আসবে
// → API তেও: email job queue এ দাও, API instantly respond করো
// ─────────────────────────────────────────────────────────────

export const emailQueue = new Queue("email-queue", {
  connection: redisClient,
  defaultJobOptions: {
    // Job fail হলে কতবার retry করবে
    attempts: 3,
    backoff: {
      type: "exponential", // প্রতিবার delay দ্বিগুণ হবে (2s → 4s → 8s)
      delay: 2000,
    },
    // Job complete হওয়ার পর কতক্ষণ রাখবে (debugging এর জন্য)
    removeOnComplete: {
      age: 24 * 3600, // ২৪ ঘণ্টা
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // ৭ দিন (failed job investigate করতে)
    },
  },
});
```

**বলো যখন শেষ — STEP 22 তে যাব।**

---

## ⚙️ STEP 22 — `src/workers/emailWorker.ts` (নতুন ফাইল)

**`src/workers/` ফোল্ডার বানাও (নতুন ফোল্ডার!), তারপর `emailWorker.ts` ফাইল বানাও:**

```typescript
import { Worker, Job } from "bullmq";
import redisClient from "../config/redis";
import emailSender from "../helpars/emailSender/emailSender";
import logger from "../utils/logger";

// ─────────────────────────────────────────────────────────────
// EMAIL WORKER
//
// Worker কী?
// → Queue এ job আসলে সেটা process করে
// → Background এ চলে, main thread block করে না
// → Job fail হলে BullMQ automatically retry করে (queue.ts এর config অনুযায়ী)
//
// Job data structure কী থাকবে?
// → subject: email এর subject
// → to: recipient email address
// → html: email এর HTML content
// ─────────────────────────────────────────────────────────────

export type EmailJobData = {
  subject: string;
  to: string;
  html: string;
};

const emailWorker = new Worker(
  "email-queue",
  async (job: Job<EmailJobData>) => {
    const { subject, to, html } = job.data;

    logger.info(`📧 Processing email job [${job.id}] → ${to}`);

    await emailSender(subject, to, html);

    logger.info(`✅ Email sent successfully [${job.id}] → ${to}`);
  },
  {
    connection: redisClient,
    // একসাথে কতটা job process করবে
    concurrency: 5,
  }
);

// Worker events — log করার জন্য
emailWorker.on("completed", (job) => {
  logger.info(`✅ Email job [${job.id}] completed.`);
});

emailWorker.on("failed", (job, err) => {
  logger.error(`❌ Email job [${job?.id}] failed:`, err.message);
});

export default emailWorker;
```

**বলো যখন শেষ — STEP 23 তে যাব।**

---

## 🏗️ STEP 23 — `src/app/modules/Auth/auth.repository.ts` (নতুন ফাইল)

**`src/app/modules/Auth/` ফোল্ডারে `auth.repository.ts` নামে নতুন ফাইল বানাও:**

```typescript
import prisma from "../../../shared/prisma";

// ─────────────────────────────────────────────────────────────
// AUTH REPOSITORY
//
// Repository Pattern কী?
// → সব DB query এখানে থাকবে
// → Service শুধু business logic লিখবে — DB কীভাবে কাজ করে জানবে না
//
// সুবিধা:
// ① Test করতে Repository mock করা যায় (real DB লাগে না)
// ② DB বদলালে শুধু Repository বদলাতে হবে
// ③ Query গুলো reusable — একই query বারবার লেখা লাগে না
// ─────────────────────────────────────────────────────────────

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
    include: { user: true }, // session এর সাথে user data ও আনো
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
```

**বলো যখন শেষ — STEP 24 তে যাব।**

---

## 🔄 STEP 24 — `src/app/modules/Auth/auth.service.ts` (UPDATE)

**এই ফাইলে বড় পরিবর্তন আসবে। পুরো ফাইলটা replace করো:**

```typescript
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

// ─────────────────────────────────────────────────────────────
// OTP Redis Helpers
//
// Redis তে OTP রাখার format:
// key   → "otp:{email}"
// value → "123456"
// TTL   → 300 seconds (5 মিনিট) — expire হলে Redis নিজেই মুছে দেয়
// ─────────────────────────────────────────────────────────────

const storeOTPInRedis = async (email: string, otp: string): Promise<void> => {
  const key = `otp:${email}`;
  await redisClient.set(key, otp, "EX", 300); // 5 মিনিট TTL
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

  // OTP এখন Redis থেকে পড়ব (DB থেকে না)
  const storedOTP = await getOTPFromRedis(email);

  if (!storedOTP) {
    throw new ApiError(httpStatus.BAD_REQUEST, "OTP has expired.");
  }

  if (!isOTPValid(otp, storedOTP)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Invalid OTP or email.");
  }

  // OTP valid → user verify করো + Redis থেকে OTP মুছো
  await Promise.all([
    AuthRepository.verifyUser(user.id),
    deleteOTPFromRedis(email),
  ]);

  // Token generate করো
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

  // Session তৈরি করো (User table এ না!)
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 দিন
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

  // Session DB তে খোঁজো
  const session = await AuthRepository.findSessionByRefreshToken(token);

  if (!session) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Session not found or expired");
  }

  // Session expired কিনা চেক করো
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

  // User verified না হলে OTP পাঠাও
  if (userData.isVerified === false) {
    const randomOtp = generateSecureOTP();

    // OTP Redis তে রাখো (DB তে না)
    await storeOTPInRedis(userData.email, randomOtp);

    // Email job Queue তে দাও (synchronous না!)
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

  // Token generate করো
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

  // Session তৈরি করো
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

  // Enumeration prevention: user না থাকলেও silently return করো
  if (!user) return;

  const randomOtp = generateSecureOTP();

  // OTP Redis তে রাখো (DB User row update করা লাগবে না!)
  await storeOTPInRedis(email, randomOtp);

  // Email async queue তে পাঠাও
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

  // Password update করো + সব session destroy করো (token invalidation)
  await Promise.all([
    AuthRepository.updateUserPassword(user.id, hashedPassword),
    AuthRepository.deleteAllUserSessions(user.id),
  ]);
};

const logOutUser = async (userId: string, refreshToken: string) => {
  // Specific session টা delete করো (শুধু এই device logout হবে)
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
```

**বলো যখন শেষ — STEP 25 তে যাব।**

---

## ⚠️ STEP 25 — `src/app/modules/Auth/auth.controller.ts` (Minor Update)

**`logOutUser` function এ একটু পরিবর্তন দরকার — `userId` এবং `refreshToken` পাঠাতে হবে:**

```typescript
// শুধু এই function টা update করো (বাকি সব same থাকবে):

const logOutUser = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.id;
  // Refresh token cookie বা header থেকে পড়ো
  const refreshToken =
    req.cookies?.token || req.headers["x-refresh-token"] as string;

  await AuthServices.logOutUser(userId, refreshToken);

  res.clearCookie("token", {
    secure: config.env === "production",
    httpOnly: true,
    sameSite: config.env === "production" ? "strict" : "lax",
  });

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: "Logged out successfully",
    data: null,
  });
});
```

---

## 🚀 STEP 26 — `src/server.ts` (Worker Start করো)

**`server.ts` তে worker import যোগ করো (শুধু ২ লাইন যোগ করতে হবে):**

`main()` function এর আগে এই import যোগ করো:
```typescript
// ফাইলের শুরুতে import এ যোগ করো:
import emailWorker from "./workers/emailWorker";
```

`main()` function এর ভেতরে server.listen এর পরে:
```typescript
// logger.info(`🚀 Server is running on port...`) এর পরে যোগ করো:
logger.info("📬 Email worker started");
// (emailWorker import করলেই automatically start হয়)
```

---

## ✅ Phase 3 শেষ হলে — TypeScript Check + Migration

```bash
# TypeScript check
cmd /c "npx tsc --noEmit 2>&1"

# Prisma client regenerate (migration পরে already হয়ে গেছে, কিন্তু নিশ্চিত করো)
npx prisma generate
```

---

## 📊 Phase 3 Summary

| Architecture | আগে | এখন |
|---|---|---|
| Token Storage | User table (`accessToken`, `refreshToken`) | Sessions table (separate, multi-device) |
| OTP Storage | DB `otp` column | Redis (auto-expire, fast) |
| Email Sending | Synchronous (user wait করে) | BullMQ Queue (async, retry on fail) |
| DB Queries | Service এ inline prisma calls | Repository pattern (testable, reusable) |

---

## 🚀 Phase 4 Preview (পরে করব)

```
PHASE 4 — Observability & Testing:
├── Structured Logging (Winston + correlation ID)
├── Unit Tests (Vitest + Repository mocking)
├── API Documentation (Swagger/OpenAPI)
└── Docker Compose (Redis + Postgres local setup)
```

**STEP 18 (Prisma schema update) দিয়ে শুরু করো! 🎯**
