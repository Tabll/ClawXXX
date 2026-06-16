/* eslint-disable react-refresh/only-export-components */
/**
 * Button Component
 * Based on shadcn/ui button
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.99]',
  {
    variants: {
      variant: {
        default: 'border border-primary/90 bg-primary text-primary-foreground shadow-sm shadow-black/10 hover:border-primary hover:bg-primary/90 focus-visible:border-ring/70 dark:shadow-black/30',
        destructive:
          'border border-transparent bg-destructive text-destructive-foreground shadow-sm hover:border-destructive hover:bg-destructive/90 focus-visible:border-ring/70',
        outline:
          'clawx-action-surface',
        secondary:
          'border border-border/60 bg-surface-input text-secondary-foreground shadow-sm shadow-black/5 hover:border-ring/35 hover:bg-surface-modal focus-visible:border-ring/60 dark:shadow-black/20',
        ghost: 'border border-transparent text-foreground/75 hover:border-border/70 hover:bg-black/5 hover:text-foreground focus-visible:border-ring/55 dark:hover:bg-white/10',
        link: 'border border-transparent text-primary underline-offset-4 hover:underline focus-visible:border-ring/55',
      },
      size: {
        default: 'h-9 px-3.5 py-2',
        sm: 'h-8 rounded-lg px-3 text-meta',
        lg: 'h-10 rounded-lg px-5',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
