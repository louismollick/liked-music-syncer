import { Link } from '@tanstack/react-router'
import { cx } from '../../lib/format'

export interface Crumb {
  label: string
  to: string
  params?: Record<string, string>
  search?: Record<string, unknown>
}

/** Ancestors only; the page itself carries its title. */
export function Crumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null
  return (
    <div className="text-[12px] text-zinc-400 mb-2">
      {items.map((item) => (
        <span key={`${item.to}-${item.label}`}>
          <Link
            to={item.to}
            params={item.params as never}
            search={item.search as never}
            className="hover:text-white"
          >
            {item.label}
          </Link>
          <span className="text-zinc-600 px-1">/</span>
        </span>
      ))}
    </div>
  )
}

export function PageTitle({
  title,
  meta,
  children,
}: {
  title: string
  meta?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-baseline gap-3 pr-56 min-h-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {meta && <span className="text-[12px] text-zinc-500">{meta}</span>}
      {children}
    </div>
  )
}

export function Page({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cx('p-6 space-y-5', className)}>{children}</div>
}

export function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold mb-4">{title}</h2>
      {children}
    </section>
  )
}
