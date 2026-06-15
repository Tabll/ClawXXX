/**
 * Input Component
 * Based on shadcn/ui input
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-lg border border-border/70 bg-surface-modal/75 px-3 py-2 text-sm text-foreground shadow-sm shadow-black/5 transition-[background-color,border-color,color] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/65 hover:border-ring/35 hover:bg-surface-modal focus-visible:border-ring/60 focus-visible:bg-surface-modal focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 dark:shadow-black/20',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
