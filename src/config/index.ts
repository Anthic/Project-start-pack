import dotenv from "dotenv";
import path from "path";

// .env
dotenv.config({ path: path.join(process.cwd(), ".env") });

// Zod validation 
import { env } from "./env";

export default {
  env: env.NODE_ENV,
  port: env.PORT,
  url: {
    frontend_url: env.FRONTEND_URL,
    backend_url: process.env.BACKEND_URL,
    image_url: env.BACKEND_IMAGE_URL,
  },
  jwt: {
    jwt_secret: env.JWT_SECRET,
    expires_in: env.EXPIRES_IN,
    refresh_token_secret: env.REFRESH_TOKEN_SECRET,
    refresh_token_expires_in: env.REFRESH_TOKEN_EXPIRES_IN,
  },
  emailSender: {
    email: env.EMAIL,
    app_pass: env.APP_PASS,
  },
  stripe: {
    stripe_secret_key: process.env.STRIPE_SECRET_KEY,
    stripe_publishable_key: process.env.STRIPE_PUBLISHABLE_KEY,
    stripe_client_id: process.env.STRIPE_CLIENT_ID,
    stripe_webhook_secret: process.env.STRIPE_WEBHOOK_SECRET,
  },
  paypal: {
    client_id: process.env.PAYPEL_CLIENT_ID,
    client_secret: process.env.PAYPAL_CLIENT_SECRET,
    mode: process.env.PAYPAL_MODE,
  },
  sendGrid: {
    api_key: process.env.SENDGRID_API_KEY,
    email_from: process.env.SENDGRID_EMAIL,
  },
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
    bucketName: process.env.AWS_BUCKET_NAME,
  },
  password: {
    password_salt: process.env.PASSWORD_SALT,
  },
  redis: {
    host: env.REDIS_HOST,
    port: Number(env.REDIS_PORT),
    password: env.REDIS_PASSWORD,
  },
};
