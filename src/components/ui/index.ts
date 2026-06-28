/**
 * Forge shared UI primitives. Import from here (`@/components/ui`) so
 * there's one canonical path per primitive.
 */

// Already-existing primitives (kept in place, re-exported for convenience).
export { Avatar } from "@/components/ui/avatar";
export { Badge } from "@/components/ui/badge";
export { Button, type ButtonProps } from "@/components/ui/button";
export { Dialog } from "@/components/ui/dialog";
export { Input } from "@/components/ui/input";

// New primitives (this PR).
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, type CardProps } from "@/components/ui/card";
export { ColorSwatchPicker, DEFAULT_LABEL_COLORS, normalizeHexColor } from "@/components/ui/color-swatch-picker";
export { DensityProvider, useDensity, useSetDensity, type Density } from "@/components/ui/density";
export { EmptyState, type EmptyStateProps } from "@/components/ui/empty-state";
export { Chord, Kbd } from "@/components/ui/kbd";
export { Section, SectionDivider, SectionHeader } from "@/components/ui/section";
export {
  Skeleton,
  SkeletonCard,
  SkeletonList,
  SkeletonRow,
  SkeletonText,
} from "@/components/ui/skeleton";
export { Spinner } from "@/components/ui/spinner";
export { Tooltip } from "@/components/ui/tooltip";
export {
  ToastProvider,
  dismissToast,
  toast,
  useToast,
  type ToastOptions,
  type ToastVariant,
} from "@/components/ui/toast";

// Motion tokens live in `src/lib/motion.ts` but are re-exported here
// for convenience — the whole design-language surface in one import.
export { MOTION, type MotionToken } from "@/lib/motion";

// Typed modal primitives (Confirm / QuickForm / SidePanel / Picker / Drawer)
// plus the shared behavior hook and draft-state helpers. Sits *above* the
// legacy `<Dialog>` primitive — call-sites should migrate to these.
export {
  Confirm,
  useConfirm,
  type ConfirmOptions,
  QuickForm,
  SidePanel,
  Picker,
  Drawer,
  useModalBehavior,
  saveDraft,
  readDraft,
  clearDraft,
} from "@/components/ui/modal";
