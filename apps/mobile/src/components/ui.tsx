import clsx from 'clsx'
import { ChevronLeft, Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { back } from '../lib/router'

export function Button({
  variant = 'secondary',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  loading?: boolean
}) {
  return (
    <button
      disabled={disabled || loading}
      className={clsx(
        'inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-medium transition-opacity active:opacity-70 disabled:opacity-40',
        variant === 'primary' && 'bg-accent text-white',
        variant === 'secondary' && 'border border-line bg-surface',
        variant === 'ghost' && 'text-fg-soft',
        variant === 'danger' && 'bg-red-600 text-white',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  )
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        'h-11 w-full rounded-xl border border-line bg-surface px-3 text-[15px] outline-none placeholder:text-fg-faint focus:border-accent',
        className,
      )}
      {...rest}
    />
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-fg-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-fg-faint">{hint}</span>}
    </label>
  )
}

export function Header({
  title,
  subtitle,
  backTo,
  right,
}: {
  title: ReactNode
  subtitle?: ReactNode
  backTo?: string
  right?: ReactNode
}) {
  // Top-level screens get the AnyDot mark instead of a back button: it leads to the website.
  return (
    <header className="safe-top sticky top-0 z-20 border-b border-line bg-canvas/90 backdrop-blur">
      <div className="flex h-12 items-center gap-1 px-2">
        {backTo !== undefined ? (
          <button
            type="button"
            aria-label="返回"
            onClick={() => back(backTo)}
            className="flex size-10 items-center justify-center rounded-full active:bg-muted"
          >
            <ChevronLeft className="size-6" />
          </button>
        ) : (
          <a
            href={HOME_URL}
            aria-label="AnyDot 首页"
            className="flex size-10 items-center justify-center rounded-full active:bg-muted"
          >
            <LogoMark className="size-6" />
          </a>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold">{title}</div>
          {subtitle && <div className="truncate text-xs text-fg-faint">{subtitle}</div>}
        </div>
        {right}
      </div>
    </header>
  )
}

const HOME_URL = 'https://anydot.app/'

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="40 26 116 128" className={className} aria-hidden="true">
      <path
        d="M84 42 L90 42 C121 42 140 64 140 90 C140 116 121 138 90 138 L62 138 Q56 138 56 132 L56 64"
        fill="none"
        stroke="currentColor"
        strokeWidth="17"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="98" cy="90" r="16" className="fill-accent" />
    </svg>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-fg-faint', className)} />
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-8 py-16 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-accent/12 text-accent">
        {icon}
      </div>
      <div className="text-[17px] font-semibold">{title}</div>
      {children && <div className="mt-2 text-sm leading-relaxed text-fg-soft">{children}</div>}
    </div>
  )
}
