'use strict';

const { z, email, password, shortText } = require('./common');

const registerSchema = z.object({
  name: shortText(120),
  email,
  password,
  phone: z.string().trim().max(20).optional(),
});

const loginSchema = z.object({ email, password: z.string().min(1).max(128) });

const refreshSchema = z.object({ refreshToken: z.string().min(10) });

const forgotPasswordSchema = z.object({ email });

const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password,
});

module.exports = {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
};
