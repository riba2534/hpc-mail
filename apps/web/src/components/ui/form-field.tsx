import { type ReactNode, useId } from 'react';
import { cn } from '@/lib/cn';

export interface FormFieldProps {
  label?: ReactNode;
  description?: ReactNode;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}

export function FormField({ label, description, error, required, htmlFor, className, children }: FormFieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const describedById = error ? `${id}-error` : description ? `${id}-desc` : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
          {required && <span className="ml-0.5 text-critical">*</span>}
        </label>
      )}
      {children({ id, 'aria-describedby': describedById, 'aria-invalid': error ? true : undefined })}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-critical">
          {error}
        </p>
      ) : description ? (
        <p id={`${id}-desc`} className="text-xs text-ink-tertiary">
          {description}
        </p>
      ) : null}
    </div>
  );
}
