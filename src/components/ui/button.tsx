import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const button = cva(
  "focus-ring inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default: "bg-foreground text-background hover:bg-foreground/90",
        subtle: "bg-subtle text-foreground hover:bg-muted",
        ghost: "hover:bg-subtle",
        ember: "bg-ember text-ember-foreground hover:bg-ember/90",
        outline: "border border-border bg-transparent hover:bg-subtle",
        danger: "bg-danger/90 text-background hover:bg-danger",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-7 px-2 text-xs",
        lg: "h-10 px-5",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(button({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";
