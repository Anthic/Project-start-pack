import Redis from "ioredis";

const redisClient = new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // usign bullMQ thats why use null
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay
    }
})

redisClient.on("connect", () => {
    console.log("Redis connected successfully....");
})

redisClient.on("error", (error) => {
    console.log("Redis connection failed:", error);
})
export default redisClient;