import Redis from "ioredis";
import config from "./index";
const redisClient = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  maxRetriesPerRequest: null,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
})

redisClient.on("connect", () => {
    console.log("Redis connected successfully....");
})

redisClient.on("error", (error) => {
    console.log("Redis connection failed:", error);
})
export default redisClient;