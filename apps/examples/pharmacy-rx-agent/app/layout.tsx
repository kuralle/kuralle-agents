import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Kuralle Pharmacy Agent',
  description: 'A durable Kuralle pharmacy agent with filesystem workspaces and progressive skills.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
