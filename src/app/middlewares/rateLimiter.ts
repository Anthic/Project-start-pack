
import rateLimit from "express-rate-limit";
export const loginLimiter = rateLimit({
    windowMs : 15*60*1000,
    max : 5,
    message : {
        success : false,
        message : "Too many login attempts. Please try again after 15 minutes.",
    },
    standardHeaders : true,
    legacyHeaders : false,
    skipSuccessfulRequests : true,
})


export const otpLimiter = rateLimit ({
    windowMs : 5*60*1000,
    max : 3,
    message : {
        success : false,
        message : "Too many otp requests. Please try again after 5 minutes.",
    },
    standardHeaders : true,
    legacyHeaders : false,
   
})


export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 100,            
  message: {
    success: false,
    message: "Too many requests. Please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});