import { AnimatePresence, motion } from 'framer-motion';
import { useEditorStore } from '@/store/editor.store';
import { useEffect } from 'react';

const COLOR = {
  info: 'var(--accent-tertiary)',
  success: 'var(--accent-primary)',
  error: 'var(--red-alert)',
} as const;

export function ToastStack(): JSX.Element {
  const toasts = useEditorStore((s) => s.toasts);
  const dismiss = useEditorStore((s) => s.dismissToast);

  useEffect(() => {
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.id), 4500));
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [toasts, dismiss]);

  return (
    <div
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 8,
        zIndex: 2000,
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ x: 30, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 20, opacity: 0 }}
            transition={{ duration: 0.18 }}
            style={{
              pointerEvents: 'auto',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderLeft: `3px solid ${COLOR[t.kind]}`,
              borderRadius: 8,
              padding: '10px 14px',
              fontSize: 12,
              color: 'var(--text-primary)',
              minWidth: 220,
              maxWidth: 360,
              boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
              cursor: 'pointer',
            }}
            onClick={() => dismiss(t.id)}
          >
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
