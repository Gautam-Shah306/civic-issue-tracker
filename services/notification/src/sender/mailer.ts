import nodemailer, { Transporter } from 'nodemailer';
import { Config } from '../config.js';

export interface EmailOptions {
  to: string;
  subject: string;
  text: string;
}

export function createMailer(config: Config): Transporter {
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: false, // Plain SMTP (Mailpit port 1025)
    ignoreTLS: true,
    connectionTimeout: 3000,
    greetingTimeout: 3000,
    socketTimeout: 3000,
    auth:
      config.SMTP_USER && config.SMTP_PASSWORD
        ? {
            user: config.SMTP_USER,
            pass: config.SMTP_PASSWORD
          }
        : undefined
  });
}

export function renderWelcomeEmail(displayName: string): { subject: string; text: string } {
  const subject = 'Welcome to Civic Issue Tracker';
  const text = `Hello ${displayName},

Welcome to Civic Issue Tracker! Your account is active and you can now submit and track reports in your community.

Best regards,
Civic Issue Tracker Team
`;
  return { subject, text };
}

export function renderReportReceivedEmail(
  displayName: string,
  title: string,
  reportId: string
): { subject: string; text: string } {
  const subject = `We received your report: ${title}`;
  const text = `Hello ${displayName},

We received your report: ${title}
Report ID: ${reportId}

Municipal officers will review and verify your submission. You will receive updates as progress is made.

Best regards,
Civic Issue Tracker Team
`;
  return { subject, text };
}

export function renderStatusChangedEmail(
  displayName: string,
  title: string,
  status: string,
  reportId: string
): { subject: string; text: string } {
  const subject = `Your report is now ${status}: ${title}`;
  const text = `Hello ${displayName},

Your report "${title}" has been updated to: ${status}
Report ID: ${reportId}

Thank you for helping improve the community.

Best regards,
Civic Issue Tracker Team
`;
  return { subject, text };
}
