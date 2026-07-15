import { redirect } from "next/navigation";

export default function LegacyAuthenticationSettings() {
  redirect("/admin/auth");
}
