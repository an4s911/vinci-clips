import { redirect } from "next/navigation";

export default function SettingsPage() {
  redirect("/clips/settings/blocked-words");
}
