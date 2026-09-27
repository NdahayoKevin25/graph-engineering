import { Request, Response, NextFunction } from 'express';

interface ErrorWithStatus extends Error {
  status?: number;
}

export const errorHandler = (
  err: ErrorWithStatus,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const status = Number.isInteger(err?.status) && err.status! >= 400 &&
    (err.status! <= 499 || (err instanceof APIError && err.status <= 599)) ? err.status! : 500;
  const message = status < 500 ? (err instanceof APIError ? err.message : 'Request failed') : 'Something went wrong';
  // Never log error objects, stacks, URLs, headers, or bodies: dependency and
  // delivery failures may embed credentials or one-time authentication tokens.
  console.error('Request failed', { status });

  res.status(status).json({
    error: {
      message,
      status,
    },
  });
};

export class APIError extends Error {
  status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    Error.captureStackTrace(this, this.constructor);
  }
}
