import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthServices } from "../src/app/modules/Auth/auth.service";
import { AuthRepository } from "../src/app/modules/Auth/auth.repository";
import * as passwordHelpers from "../src/utils/passwordHelpers";
import { UserStatus, UserRole } from "@prisma/client";

// Mock AuthRepository to test business logic in isolation without touching a real database
vi.mock("../src/app/modules/Auth/auth.repository", () => ({
  AuthRepository: {
    findUserByEmail: vi.fn(),
    findUserById: vi.fn(),
    findUserProfileByEmail: vi.fn(),
    createSession: vi.fn(),
    verifyUser: vi.fn(),
  },
}));

vi.mock("../src/config/redis", () => ({
  default: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    ping: vi.fn(),
  },
}));

vi.mock("../src/config/queue", () => ({
  emailQueue: {
    add: vi.fn(),
  },
}));

describe("AuthServices - loginUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should throw 401 error if user does not exist", async () => {
    vi.mocked(AuthRepository.findUserByEmail).mockResolvedValue(null);

    await expect(
      AuthServices.loginUser("nonexistent@example.com", "password123")
    ).rejects.toThrow("Invalid email or password.");
  });

  it("should throw 403 error if user account is deleted", async () => {
    vi.mocked(AuthRepository.findUserByEmail).mockResolvedValue({
      id: "user-123",
      email: "deleted@example.com",
      password: "hashedPassword",
      status: UserStatus.DELETED,
      role: UserRole.USER,
      isVerified: true,
    } as any);

    await expect(
      AuthServices.loginUser("deleted@example.com", "password123")
    ).rejects.toThrow("Your account has been deleted.");
  });

  it("should throw 401 error if password does not match", async () => {
    vi.mocked(AuthRepository.findUserByEmail).mockResolvedValue({
      id: "user-123",
      email: "user@example.com",
      password: "hashedPassword",
      status: UserStatus.ACTIVE,
      role: UserRole.USER,
      isVerified: true,
    } as any);

    vi.spyOn(passwordHelpers, "comparePassword").mockResolvedValue(false);

    await expect(
      AuthServices.loginUser("user@example.com", "wrongPassword")
    ).rejects.toThrow("Invalid email or password.");
  });
});
