import { Queue } from "bullmq";
import redisClient from "./redis";

export const emailQueue = new Queue('email-queue', {
    connection: redisClient,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 2000,
        },
        removeOnComplete: {
            age: 24 * 3600,
        },
        removeOnFail: {
            age: 7 * 24 * 3600,
        },
    },
})