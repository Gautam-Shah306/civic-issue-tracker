import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthProvider.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { ApiError } from '../../api/client.js';

export const RegisterPage: React.FC = () => {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get('returnTo') || '/my';

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneralError(null);
    const errors: Record<string, string> = {};

    if (!displayName.trim()) {
      errors.displayName = 'Full name is required';
    } else if (displayName.trim().length > 100) {
      errors.displayName = 'Full name cannot exceed 100 characters';
    }

    if (!email.trim()) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.email = 'Invalid email address';
    }

    if (!password) {
      errors.password = 'Password is required';
    } else if (password.length < 10) {
      errors.password = 'Password must be at least 10 characters';
    } else if (password.length > 128) {
      errors.password = 'Password cannot exceed 128 characters';
    } else if (password.toLowerCase() === email.trim().toLowerCase()) {
      errors.password = 'Password cannot match your email';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});

    try {
      setIsSubmitting(true);
      await register({
        displayName: displayName.trim(),
        email: email.trim(),
        password
      });
      navigate(returnTo, { replace: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.errors && err.errors.length > 0) {
          const mapped: Record<string, string> = {};
          for (const fe of err.errors) {
            mapped[fe.field] = fe.message;
          }
          setFieldErrors(mapped);
        } else {
          setGeneralError(err.message || 'Registration failed');
        }
      } else {
        setGeneralError('Registration failed. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-md mx-auto py-8">
      <Card>
        <h1 className="text-2xl font-semibold text-text mb-6">Create an Account</h1>

        {generalError && (
          <div className="mb-4">
            <ErrorNotice title="Registration Error" message={generalError} />
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <Field
            id="register-name"
            type="text"
            label="Full Name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            error={fieldErrors.displayName}
            autoComplete="name"
            required
          />

          <Field
            id="register-email"
            type="email"
            label="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldErrors.email}
            autoComplete="email"
            required
          />

          <Field
            id="register-password"
            type="password"
            label="Password"
            hint="At least 10 characters, must not match your email"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldErrors.password}
            autoComplete="new-password"
            required
          />

          <div className="pt-2">
            <Button
              type="submit"
              variant="primary"
              size="md"
              className="w-full"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Creating account...' : 'Create Account'}
            </Button>
          </div>
        </form>

        <p className="text-sm text-text-muted mt-6 text-center">
          Already have an account?{' '}
          <Link to={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="link">
            Sign in
          </Link>
        </p>
      </Card>
    </div>
  );
};
