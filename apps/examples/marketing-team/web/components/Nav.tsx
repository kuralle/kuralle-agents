'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Chat' },
  { href: '/content', label: 'Content' },
  { href: '/brand', label: 'Brand' },
  { href: '/assets', label: 'Assets' },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="topbar">
      <span className="topbar__brand">Marketing workspace</span>
      <nav className="topbar__nav">
        {LINKS.map((link) => {
          const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
          return (
            <Link key={link.href} href={link.href} data-active={active}>
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
