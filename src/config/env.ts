import { z } from "zod";

const EnvSchema = z.object({
  // App
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.string().default("8000"),

  // Database
  DATABASE_URL: z
    .string()
    .url()
    .refine((val) => val.startsWith("postgresql://") || val.startsWith("postgres://"), {
      message: "DATABASE_URL must start with postgresql:// or postgres://",
    }),

  // JWT
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  EXPIRES_IN: z.string().default("15m"),
  REFRESH_TOKEN_SECRET: z.string().min(32, "REFRESH_TOKEN_SECRET must be at least 32 characters"),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default("7d"),

  // Redis
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.string().default("6379"),
  REDIS_PASSWORD: z.string().optional(),

  // Email (optional for startup)
  EMAIL: z.string().email().optional().or(z.literal("")),
  APP_PASS: z.string().optional().or(z.literal("")),

  // Frontend
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  BACKEND_IMAGE_URL: z.string().optional(),
  RESET_PASS_LINK: z.string().optional(),
});


const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables detected. Server cannot start:\n");
  const errors = parsed.error.format();
  Object.entries(errors).forEach(([key, val]) => {
    if (key === "_errors") return;
    const messages = (val as any)?._errors?.join(", ");
    if (messages) console.error(`  ● ${key}: ${messages}`);
  });
  process.exit(1);
}

export const env = parsed.data;
