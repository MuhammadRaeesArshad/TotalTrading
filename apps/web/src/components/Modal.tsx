import { useEffect } from 'react';

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="ov on"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="mod" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mod-h">
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        <div className="mod-b">{children}</div>
        {footer && <div className="mod-f">{footer}</div>}
      </div>
    </div>
  );
}
