import { redirect } from "next/navigation";

export default async function ProjectTemplatesRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/w/${slug}/settings/templates?type=project`);
}
