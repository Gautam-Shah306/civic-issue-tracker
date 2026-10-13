export interface ValidationErrorDetail {
  field: string;
  message: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  correlationId: string;
  errors?: ValidationErrorDetail[];
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly type: string;
  public readonly errors?: ValidationErrorDetail[];

  constructor(options: {
    message: string;
    statusCode: number;
    code: string;
    type?: string;
    errors?: ValidationErrorDetail[];
  }) {
    super(options.message);
    this.name = 'AppError';
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.type =
      options.type ||
      `https://api.civic-issue-tracker.local/errors/${options.code.toLowerCase().replace(/_/g, '-')}`;
    this.errors = options.errors;
  }
}

export function formatProblemDetails(options: {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  correlationId: string;
  errors?: ValidationErrorDetail[];
}): ProblemDetails {
  const result: ProblemDetails = {
    type:
      options.type ||
      `https://api.civic-issue-tracker.local/errors/${options.code.toLowerCase().replace(/_/g, '-')}`,
    title: options.title,
    status: options.status,
    code: options.code,
    correlationId: options.correlationId
  };

  if (options.detail !== undefined) {
    result.detail = options.detail;
  }
  if (options.instance !== undefined) {
    result.instance = options.instance;
  }
  if (options.errors !== undefined && options.errors.length > 0) {
    result.errors = options.errors;
  }

  return result;
}
