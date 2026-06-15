import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-lg border border-border/70 bg-surface-modal/75 px-3 py-2 text-sm text-foreground shadow-sm shadow-black/5 transition-[background-color,border-color,color] placeholder:text-muted-foreground/65 hover:border-ring/35 hover:bg-surface-modal focus-visible:border-ring/60 focus-visible:bg-surface-modal focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 dark:shadow-black/20",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
