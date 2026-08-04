import type { Metadata } from 'next';
import { Nav } from '@/components/Nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Marketing workspace',
  description: 'Chat with the marketing team and edit the content they produce.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Nav />
          {children}
        </div>
      </body>
    </html>
  );
}
