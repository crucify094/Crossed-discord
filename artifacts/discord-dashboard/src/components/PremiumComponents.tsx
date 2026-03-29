import React, { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Loader2 } from 'lucide-react';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Beautiful glassmorphic card
export function PremiumCard({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("glass-panel rounded-2xl p-6 transition-all duration-300 hover:shadow-primary/5", className)} {...props}>
      {children}
    </div>
  );
}

// Custom Switch since Shadcn requires specific Radix setup
export function PremiumSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: (c: boolean) => void; disabled?: boolean }) {
  return (
    <div className={cn("relative inline-flex items-center", disabled && "opacity-50 cursor-not-allowed")}>
      <input
        type="checkbox"
        className="sr-only toggle-checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        id={`switch-${Math.random()}`}
      />
      <label
        className="toggle-label block overflow-hidden cursor-pointer"
        onClick={() => !disabled && onChange(!checked)}
      />
    </div>
  );
}

// High-end primary button
export function PremiumButton({ 
  className, children, isLoading, variant = 'primary', ...props 
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean, variant?: 'primary' | 'secondary' | 'danger' }) {
  
  const variants = {
    primary: "bg-gradient-to-r from-primary to-primary/80 text-white shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/40 hover:-translate-y-0.5 border-none",
    secondary: "bg-secondary text-foreground hover:bg-secondary/80 hover:-translate-y-0.5 border border-white/5",
    danger: "bg-gradient-to-r from-destructive to-destructive/80 text-white shadow-lg shadow-destructive/25 hover:shadow-destructive/40 hover:-translate-y-0.5 border-none",
  };

  return (
    <button
      className={cn(
        "px-5 py-2.5 rounded-xl font-semibold inline-flex items-center justify-center transition-all duration-200 active:scale-95 disabled:opacity-50 disabled:pointer-events-none disabled:transform-none",
        variants[variant],
        className
      )}
      disabled={isLoading || props.disabled}
      {...props}
    >
      {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
      {children}
    </button>
  );
}

export function PremiumInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input 
      className={cn(
        "w-full px-4 py-3 rounded-xl bg-input border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all",
        className
      )}
      {...props}
    />
  );
}

export function PremiumSelect({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select 
      className={cn(
        "w-full px-4 py-3 rounded-xl bg-input border border-border/50 text-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all appearance-none",
        className
      )}
      style={{ backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`, backgroundPosition: `right 0.5rem center`, backgroundRepeat: `no-repeat`, backgroundSize: `1.5em 1.5em`, paddingRight: `2.5rem` }}
      {...props}
    >
      {children}
    </select>
  );
}

export function PremiumTextarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea 
      className={cn(
        "w-full px-4 py-3 rounded-xl bg-input border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all min-h-[100px] resize-y",
        className
      )}
      {...props}
    />
  );
}

export function PageHeader({ title, description, badge }: { title: string, description: string, badge?: React.ReactNode }) {
  return (
    <div className="mb-8 relative z-10">
      <div className="flex items-center gap-4 mb-2">
        <h1 className="text-3xl font-display font-bold text-gradient">{title}</h1>
        {badge}
      </div>
      <p className="text-muted-foreground text-lg max-w-2xl">{description}</p>
    </div>
  );
}
