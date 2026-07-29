import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { supportConfig } from '../support.config';
import './styles.css';

export const metadata: Metadata = {
  title: `${supportConfig.brand.agentName} — ${supportConfig.brand.companyName} Support`,
  description: supportConfig.brand.tagline,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ '--brand-accent': supportConfig.brand.accent } as React.CSSProperties}>
        {children}
      </body>
    </html>
  );
}
