"use client";
import { useCallback, useRef, useState } from "react";

interface UseResizeHandleArgs {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Snapped final size, called on pointer up. */
  onResizeEnd: (width: number, height: number) => void;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  /**
   * Which corner the panel is anchored to. We resize FROM the opposite
   * corner: bottom-right anchor means the resize handle is at top-left,
   * etc. For now we only support bottom-right anchor (handle at top-left
   * visually) since that's the panel's default. If anchored elsewhere
   * the math flips signs — adjust here if/when needed.
   */
  anchor?: "br" | "bl" | "tr" | "tl";
  disabled?: boolean;
}

export function useResizeHandle(args: UseResizeHandleArgs): {
  onPointerDown: (e: React.PointerEvent) => void;
  isResizing: boolean;
} {
  const [isResizing, setIsResizing] = useState(false);
  const startRef = useRef<{
    pointerX: number;
    pointerY: number;
    width: number;
    height: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (args.disabled) return;
      const node = args.containerRef.current;
      if (!node) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = node.getBoundingClientRect();
      startRef.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        width: rect.width,
        height: rect.height,
      };
      setIsResizing(true);
      const anchor = args.anchor ?? "br";
      const onMove = (ev: PointerEvent) => {
        if (!startRef.current) return;
        const dx = ev.clientX - startRef.current.pointerX;
        const dy = ev.clientY - startRef.current.pointerY;
        // For bottom-right anchored panel, dragging top-left handle:
        // moving up-left grows the panel. So new width = startW - dx,
        // new height = startH - dy.
        const flipX = anchor === "br" || anchor === "tr" ? -1 : 1;
        const flipY = anchor === "br" || anchor === "bl" ? -1 : 1;
        const w = Math.max(args.minWidth, Math.min(args.maxWidth, startRef.current.width + flipX * dx));
        const h = Math.max(args.minHeight, Math.min(args.maxHeight, startRef.current.height + flipY * dy));
        node.style.width = `${w}px`;
        node.style.height = `${h}px`;
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        setIsResizing(false);
        const finalRect = node.getBoundingClientRect();
        startRef.current = null;
        args.onResizeEnd(Math.round(finalRect.width), Math.round(finalRect.height));
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    },
    [args],
  );

  return { onPointerDown, isResizing };
}
