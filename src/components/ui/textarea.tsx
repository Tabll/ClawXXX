import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-lg border border-border/70 bg-surface-modal/75 px-3 py-2 text-base text-foreground shadow-sm shadow-black/5 ring-offset-background transition-[background-color,border-color,box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-ring/55 focus-visible:bg-surface-modal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:shadow-black/20",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
