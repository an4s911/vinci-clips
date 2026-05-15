"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  ShieldAlert,
  Palette,
  Settings as SettingsIcon,
  ChevronRight,
  Sparkles
} from "lucide-react";

const sidebarItems = [
  {
    title: "Content Filter",
    href: "/clips/settings/blocked-words",
    icon: ShieldAlert,
    description: "Manage blocked words and phrases"
  },
  {
    title: "Captions",
    href: "/clips/settings/caption-templates",
    icon: Palette,
    description: "Design caption styles and templates"
  },
  {
    title: "AI Prompts",
    href: "/clips/settings/prompts",
    icon: Sparkles,
    description: "Customize AI prompts"
  },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="container mx-auto max-w-7xl p-6 lg:p-10">
      <div className="flex flex-col gap-8 md:flex-row">
        {/* Sidebar */}
        <aside className="w-full md:w-64 lg:w-72 shrink-0">
          <div className="space-y-6">
            <div>
              <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-br from-foreground to-foreground/60 bg-clip-text text-transparent flex items-center gap-2">
                <SettingsIcon className="h-7 w-7 text-primary" />
                Settings
              </h1>
              <p className="text-sm text-muted-foreground mt-2">
                Configure your application preferences.
              </p>
            </div>
            
            <nav className="flex flex-col gap-1">
              {sidebarItems.map((item) => {
                const isActive = pathname === item.href || (item.href !== "/clips/settings" && pathname.startsWith(item.href));
                const Icon = item.icon;
                
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "group flex items-center justify-between rounded-xl px-4 py-3 transition-all duration-200",
                      isActive 
                        ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20" 
                        : "hover:bg-muted text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "rounded-lg p-1.5 transition-colors",
                        isActive ? "bg-white/20" : "bg-muted group-hover:bg-background"
                      )}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold">{item.title}</span>
                      </div>
                    </div>
                    {isActive && <ChevronRight className="h-4 w-4 opacity-50" />}
                  </Link>
                );
              })}
            </nav>
          </div>
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="h-full rounded-3xl border border-muted-foreground/10 bg-card/30 backdrop-blur-sm p-6 lg:p-8 animate-in fade-in slide-in-from-right-4 duration-500">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
