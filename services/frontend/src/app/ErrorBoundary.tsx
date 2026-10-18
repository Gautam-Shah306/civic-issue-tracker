import { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="p-6 max-w-xl mx-auto my-12">
          <Card surface>
            <h1 className="text-2xl font-semibold text-danger-text mb-2">An error occurred</h1>
            <p className="text-sm text-text-muted mb-4">
              {this.state.error?.message ||
                'An unexpected error occurred while rendering this page.'}
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.assign('/');
              }}
            >
              Return Home
            </Button>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
