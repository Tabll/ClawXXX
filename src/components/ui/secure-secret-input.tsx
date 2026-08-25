import React from 'react';
import { cn } from '@/lib/utils';

export interface SecureSecretInputHandle {
  /** Stages the secret directly from the isolated preload element into Main. */
  stage(): Promise<string | null>;
  clear(): void;
  focus(): void;
}

interface SecureSecretInputProps {
  id?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
  onPresenceChange?: (hasValue: boolean) => void;
}

/**
 * A closed-shadow, preload-defined secret field. React receives presence and
 * an opaque staging handle only; it never receives the credential value.
 */
export const SecureSecretInput = React.forwardRef<SecureSecretInputHandle, SecureSecretInputProps>(
  function SecureSecretInput({ onPresenceChange, className, placeholder, disabled, ...props }, forwardedRef) {
    const elementRef = React.useRef<HTMLDivElement | null>(null);
    const id = React.useId();

    React.useImperativeHandle(forwardedRef, () => ({
      async stage() {
        if (!window.clawxSecureSecrets) {
          throw new Error('Secure credential input is unavailable');
        }
        return window.clawxSecureSecrets.stage(id);
      },
      clear() {
        window.clawxSecureSecrets?.clear(id);
      },
      focus() {
        window.clawxSecureSecrets?.focus(id);
      },
    }), [id]);

    React.useEffect(() => {
      const element = elementRef.current;
      if (!element || !onPresenceChange) return;
      const listener = (event: Event) => {
        const detail = (event as CustomEvent<{ hasValue?: unknown }>).detail;
        onPresenceChange(detail?.hasValue === true);
      };
      element.addEventListener('secret-state-change', listener);
      return () => element.removeEventListener('secret-state-change', listener);
    }, [onPresenceChange]);

    return (
      <div
        ref={elementRef}
        data-clawx-secret-id={id}
        data-placeholder={placeholder}
        data-disabled={disabled ? 'true' : undefined}
        className={cn('block w-full', className)}
        {...props}
      />
    );
  },
);
