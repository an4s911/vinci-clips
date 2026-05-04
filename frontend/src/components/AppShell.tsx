"use client";

import { usePathname } from "next/navigation";
import Header from "@/components/ui/Header";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = pathname === "/login";

  if (isAuthPage) return <>{children}</>;

  return (
    <>
      <Header />
      {children}
    </>
  );
}
