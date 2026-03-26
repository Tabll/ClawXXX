import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 shrink-0 gap-4 animate-page-in">
      <div>
        <h1 className="page-title text-[1.75rem] md:text-[2rem] text-foreground mb-1.5 animate-title-in">
          {title}
        </h1>
        {subtitle && (
          <p className="page-subtitle text-[13.5px] text-muted-foreground animate-subtitle-in">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2.5 animate-subtitle-in">
          {actions}
        </div>
      )}
    </div>
  );
}

interface SectionHeaderProps {
  title: string;
  className?: string;
}

export function SectionHeader({ title, className }: SectionHeaderProps) {
  return (
    <h2 className={`section-title text-lg text-foreground mb-5 title-decoration ${className ?? ''}`}>
      {title}
    </h2>
  );
}
