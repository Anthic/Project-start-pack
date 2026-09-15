import { Worker, Job } from "bullmq";
import redisClient from "../config/redis";
import emailSender from "../helpars/emailSender/emailSender";
import logger from "../utils/logger";


export type EmailJobData = {
    subject : string
    to : string
    html : string
}

const emailWorker = new Worker(
  "email-queue",
  async (job: Job<EmailJobData>) => {
    const { subject, to, html } = job.data;
    logger.info(`Processing email job [${job.id}] → ${to}`);
    await emailSender(subject, to, html);
    logger.info(`Email sent successfully [${job.id}] → ${to}`);
  },
  {
    connection: redisClient,
   
    concurrency: 5,
  }
);

emailWorker.on("completed", (job) => {
  logger.info(`Email job [${job.id}] completed.`);
});
emailWorker.on("failed", (job, err) => {
  logger.error(`Email job [${job?.id}] failed:`, err.message);
});


export default emailWorker;