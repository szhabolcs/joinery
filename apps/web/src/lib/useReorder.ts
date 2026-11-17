/**
 * Drag-to-reorder for a list of keyed rows, on the browser's own drag and
 * drop (no library). A row spreads `rowProps(key)` onto its element; while a
 * row is dragged over another, the target carries `data-drop="before"` or
 * `"after"` for the drop line. `move(key, delta)` is the keyboard path (the
 * grip handle's arrow keys). Either way the caller gets one move: which
 * row, and which row it lands before or after.
 */
import { useState } from 'react';

export type ReorderMove = (moved: string, target: string, side: 'before' | 'after') => void;

export interface ReorderRowProps {
  draggable: boolean;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
  onDrop: (e: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  'data-drop'?: 'before' | 'after';
  'data-dragging'?: true;
}

export interface Reorder {
  rowProps(key: string): ReorderRowProps;
  move(key: string, delta: number): void;
}

/** `keys`: the rows in their shown order. */
export function useReorder(keys: readonly string[], onMove: ReorderMove, enabled: boolean): Reorder {
  const [dragged, setDragged] = useState<string | null>(null);
  const [target, setTarget] = useState<{ key: string; side: 'before' | 'after' } | null>(null);

  const finish = (): void => {
    setDragged(null);
    setTarget(null);
  };

  const rowProps = (key: string): ReorderRowProps => ({
    draggable: enabled,
    onDragStart: (e) => {
      if (!enabled) return;
      e.dataTransfer.effectAllowed = 'move';
      // Firefox only starts a drag that carries data.
      e.dataTransfer.setData('text/plain', key);
      setDragged(key);
    },
    onDragOver: (e) => {
      if (dragged === null || dragged === key) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const box = e.currentTarget.getBoundingClientRect();
      const side = e.clientY < box.top + box.height / 2 ? 'before' : 'after';
      if (target?.key !== key || target.side !== side) setTarget({ key, side });
    },
    onDragLeave: (e) => {
      // Leaving into a child of the same row isn't leaving the row.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      if (target?.key === key) setTarget(null);
    },
    onDrop: (e) => {
      e.preventDefault();
      if (dragged !== null && target !== null && dragged !== target.key) onMove(dragged, target.key, target.side);
      finish();
    },
    onDragEnd: finish,
    ...(target?.key === key && dragged !== key ? { 'data-drop': target.side } : {}),
    ...(dragged === key ? { 'data-dragging': true as const } : {}),
  });

  const move = (key: string, delta: number): void => {
    const neighbour = keys[keys.indexOf(key) + delta];
    if (keys.indexOf(key) === -1 || neighbour === undefined) return;
    onMove(key, neighbour, delta < 0 ? 'before' : 'after');
  };

  return { rowProps, move };
}
