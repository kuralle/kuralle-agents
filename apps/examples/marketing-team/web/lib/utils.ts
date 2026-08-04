import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** The shadcn/ui class combiner the AI Elements components import from `@/lib/utils`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
