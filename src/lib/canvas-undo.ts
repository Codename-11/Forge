// Client-side undo / redo stack for canvas mutations (W3.1).
//
// Each operation pushes a `{ describe, doIt, undoIt }` record. Cmd+Z
// pops from the undo stack and runs `undoIt`, pushing the same record
// onto the redo stack. Cmd+Shift+Z reverses. The stack is purely
// in-memory: it doesn't survive a page reload, and a failed mutation
// invalidates the stack (we re-sync with server state rather than try
// to reconcile a divergent history).
//
// v1 scope: shape move and shape delete. Adds/groups/edges can be
// wired by following the same `pushCommand` shape from their commit
// sites.

import { useCallback, useRef, useState } from "react";

export type UndoCommand = {
  /** Short label for the toast feedback. */
  describe: string;
  /** Forward operation — used by `redo`. The initial caller has
   *  already run the operation, so push happens AFTER the do completes.
   *  Redo re-runs this body. */
  doIt: () => void;
  /** Inverse operation — used by `undo`. Should not throw on a stale
   *  canvas; if the targeted row is gone, treat as a no-op. */
  undoIt: () => void;
};

const STACK_CAP = 100;

export function useCanvasUndoStack(canvasId: string) {
  const undoStack = useRef<UndoCommand[]>([]);
  const redoStack = useRef<UndoCommand[]>([]);
  // Rev counter so subscribers can know when the stack changes (e.g.
  // to enable/disable Cmd+Z menu items in the future).
  const [rev, setRev] = useState(0);

  // Wipe on canvas change — we can't undo across different canvases.
  const lastCanvasIdRef = useRef(canvasId);
  if (lastCanvasIdRef.current !== canvasId) {
    lastCanvasIdRef.current = canvasId;
    undoStack.current = [];
    redoStack.current = [];
  }

  const push = useCallback((cmd: UndoCommand) => {
    undoStack.current.push(cmd);
    if (undoStack.current.length > STACK_CAP) {
      undoStack.current.shift();
    }
    // Any new operation invalidates redo (standard editor behaviour).
    redoStack.current = [];
    setRev((r) => r + 1);
  }, []);

  const undo = useCallback((): UndoCommand | null => {
    const cmd = undoStack.current.pop();
    if (!cmd) return null;
    try {
      cmd.undoIt();
    } catch {
      // Treat failures as fatal — wipe both stacks so we don't dispatch
      // operations against a divergent server state.
      undoStack.current = [];
      redoStack.current = [];
      setRev((r) => r + 1);
      return null;
    }
    redoStack.current.push(cmd);
    setRev((r) => r + 1);
    return cmd;
  }, []);

  const redo = useCallback((): UndoCommand | null => {
    const cmd = redoStack.current.pop();
    if (!cmd) return null;
    try {
      cmd.doIt();
    } catch {
      undoStack.current = [];
      redoStack.current = [];
      setRev((r) => r + 1);
      return null;
    }
    undoStack.current.push(cmd);
    setRev((r) => r + 1);
    return cmd;
  }, []);

  const clear = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    setRev((r) => r + 1);
  }, []);

  return {
    push,
    undo,
    redo,
    clear,
    rev,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  };
}
