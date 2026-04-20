import { cn, initials } from "@/lib/utils";

export function Avatar({
  name,
  image,
  size = 20,
  className,
}: {
  name?: string | null;
  image?: string | null;
  size?: number;
  className?: string;
}) {
  const dim = { width: size, height: size };
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image} alt={name ?? ""} style={dim} className={cn("rounded-full object-cover", className)} />;
  }
  return (
    <span
      style={dim}
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-subtle font-mono text-[10px] text-muted-foreground",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
