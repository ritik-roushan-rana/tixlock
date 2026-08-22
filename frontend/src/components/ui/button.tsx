import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        /** Ink block, cream label. The safe default for almost every button. */
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        /**
         * Lime signal. Reserved for the single most important action on a screen —
         * "Get tickets", "Hold seats", "Confirm booking". If two of these appear on
         * one screen, one of them is wrong. Always carries ink text (12.95:1); never
         * white, which sits at 1.32:1 on lime.
         */
        lime: 'bg-lime text-lime-foreground hover:bg-lime-dim',
        /** Cobalt. Informational or selection-led actions, e.g. join waitlist. */
        cobalt: 'bg-cobalt text-cobalt-foreground hover:bg-cobalt/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        /** 1px ink outline, per the spec's ghost button. Thickens on focus. */
        outline:
          'border border-border-strong bg-background hover:bg-card-alt focus-visible:border-2',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-card-alt',
        ghost: 'hover:bg-card-alt',
        link: 'text-foreground underline decoration-1 underline-offset-4 hover:decoration-2',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-11 px-6',
        /**
         * Hero-scale action. Matches the reference's px-lg py-md CTA.
         *
         * The size is spelled out as `text-[0.9375rem] font-semibold` rather than
         * using the `text-ui-action` token, and that is deliberate. `ui-action` is a
         * custom fontSize key, so tailwind-merge cannot tell `text-ui-action` from a
         * text *colour*; because `size` is concatenated after `variant`, it won the
         * merge and silently stripped the variant's `text-cobalt-foreground`. That
         * left ink on cobalt at about 1.7:1. An arbitrary value is unambiguous.
         */
        xl: 'h-14 px-8 text-[0.9375rem] font-semibold',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';

    // asChild renders a single arbitrary child, so injecting a spinner would break
    // Slot's single-child contract. Loading state is only decorated on real buttons.
    if (asChild) {
      return (
        <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props}>
          {children}
        </Comp>
      );
    }

    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
