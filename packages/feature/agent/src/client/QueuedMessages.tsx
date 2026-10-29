'use client';

/**
 * THE "SEND NEXT" CARDS above the composer (specs/chat-message-queue.md R2).
 *
 * Each message written while naby is answering waits here until the run ends
 * (messageQueue.ts decides what happens then). A card shows the first two lines
 * of the body, how many images ride along, and two buttons: edit (back into the
 * composer, out of the queue) and delete.
 *
 * `memo`'d with a memo'd row: Chat re-renders on every streamed delta, and the
 * queue only changes when the user acts. The callbacks it is handed must be
 * stable (CLAUDE.md, React Performance Conventions).
 */

import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2, Clock } from 'lucide-react';
import type { QueuedMessage } from './messageQueue';

interface QueuedMessagesProps {
  items: readonly QueuedMessage[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

const QueuedMessageRow = memo(function QueuedMessageRow({
  item,
  onEdit,
  onDelete,
}: {
  item: QueuedMessage;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const edit = useCallback(() => onEdit(item.id), [onEdit, item.id]);
  const remove = useCallback(() => onDelete(item.id), [onDelete, item.id]);
  const imageCount = item.images?.length ?? 0;
  return (
    <li
      className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-card"
      data-testid="queued-message"
    >
      <div className="min-w-0 flex-1">
        {item.content ? (
          <p className="line-clamp-2 whitespace-pre-wrap break-words text-foreground">{item.content}</p>
        ) : null}
        {imageCount > 0 ? (
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="queued-message-images">
            {t('chat.queuedImages', { count: imageCount })}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={edit}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={t('chat.queuedEdit')}
        aria-label={t('chat.queuedEdit')}
        data-testid="queued-message-edit"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={remove}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={t('chat.queuedDelete')}
        aria-label={t('chat.queuedDelete')}
        data-testid="queued-message-delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
});

export const QueuedMessages = memo(function QueuedMessages({ items, onEdit, onDelete }: QueuedMessagesProps) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <div className="px-4 pt-2" data-testid="queued-messages">
      <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        <span>{t('chat.queuedHeading')}</span>
      </div>
      {/* Bounded and scrollable on its own, so a long queue cannot push the
          composer off screen. Not a popover host — the clip is safe here. */}
      <ul className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
        {items.map((item) => (
          <QueuedMessageRow key={item.id} item={item} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </ul>
    </div>
  );
});
