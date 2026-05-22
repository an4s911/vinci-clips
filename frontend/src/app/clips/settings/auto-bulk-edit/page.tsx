"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CaptionTemplatePreview, CaptionPreviewTemplate, CaptionPreviewAspect } from "@/components/CaptionTemplatePreview";
import { Loader2, Monitor, Smartphone, Square, Zap } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

function getErrorMessage(error: unknown, fallback: string) {
  return axios.isAxiosError<{ error?: string }>(error)
    ? error.response?.data?.error || fallback
    : fallback;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface CaptionStyle extends CaptionPreviewTemplate {
  id: string;
  name: string;
  description?: string;
  usage?: "captions" | "hooks" | "both";
}

interface AutoBulkEditConfig {
  enabled: boolean;
  reframe: { enabled: boolean; platform: string; reframeStyleId: string };
  captions: { enabled: boolean; styleId: string | null };
  hook: { enabled: boolean; styleId: string | null; timeoutSeconds: number | null };
}

// ── Constants ────────────────────────────────────────────────────────────────

const PLATFORMS = [
  { id: "tiktok",    name: "TikTok / Shorts",  aspectRatio: "9:16", icon: <Smartphone className="h-5 w-5" />, previewAspect: "portrait"  as CaptionPreviewAspect },
  { id: "instagram", name: "Instagram Square", aspectRatio: "1:1",  icon: <Square      className="h-5 w-5" />, previewAspect: "square"    as CaptionPreviewAspect },
  { id: "youtube",   name: "YouTube Wide",     aspectRatio: "16:9", icon: <Monitor     className="h-5 w-5" />, previewAspect: "landscape" as CaptionPreviewAspect },
];

const REFRAME_STYLES = [
  { id: "fullscreen", name: "Fullscreen", preview: "/reframe-styles/fullscreen.svg" },
  { id: "blurred",    name: "Blurred",    preview: "/reframe-styles/blurred.svg"    },
];

const DEFAULT_CONFIG: AutoBulkEditConfig = {
  enabled: false,
  reframe:  { enabled: true, platform: "tiktok", reframeStyleId: "fullscreen" },
  captions: { enabled: true, styleId: null },
  hook:     { enabled: true, styleId: null, timeoutSeconds: null },
};

// ── Sub-components (match BulkEditModal exactly) ──────────────────────────────

function SectionHeader({ title, enabled, onToggle }: { title: string; enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border-2 text-left transition-colors ${
        enabled ? "border-primary bg-primary/5" : "border-muted hover:border-muted-foreground/40"
      }`}
    >
      <span className="font-medium text-sm">{title}</span>
      <span className={`text-xs px-2 py-0.5 rounded-full ${enabled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
        {enabled ? "On" : "Off"}
      </span>
    </button>
  );
}

function ReframeStylePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 pr-1">
      {REFRAME_STYLES.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={() => onChange(s.id)}
          className={`flex w-28 flex-none flex-col items-center gap-1 rounded-lg border-2 p-1 transition-colors ${
            value === s.id ? "border-primary bg-primary/5" : "border-transparent hover:border-muted-foreground/30"
          }`}
        >
          <div className="relative overflow-hidden rounded w-full" style={{ height: 86, background: "#0f172a" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.preview} alt={s.name} className="w-full h-full object-contain" />
          </div>
          <span className="text-xs font-medium truncate w-full text-center">{s.name}</span>
        </button>
      ))}
    </div>
  );
}

function StyleGrid({ styles, value, onChange }: { styles: CaptionStyle[]; value: string; onChange: (id: string) => void }) {
  const getCardPreviewTemplate = (style: CaptionStyle): CaptionStyle => ({
    ...style,
    alignment: 5,
    outlineWidth: style.borderStyle === 3 ? style.outlineWidth : Math.max(style.outlineWidth ?? 0, 5),
    scaleX: 1,
    scaleY: 1,
    spacing: 0,
    layouts: {
      ...style.layouts,
      portrait: {
        ...style.layouts.portrait,
        fontSize: 96,
        marginV: 0,
        marginL: 0,
        marginR: 0,
      },
    },
  });

  if (styles.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
        No eligible templates.
      </div>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-2 pr-1">
      {styles.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={() => onChange(s.id)}
          className={`flex w-28 flex-none flex-col items-center gap-1 rounded-lg border-2 p-1 transition-colors ${
            value === s.id ? "border-primary bg-primary/5" : "border-transparent hover:border-muted-foreground/30"
          }`}
        >
          <CaptionTemplatePreview
            template={getCardPreviewTemplate(s)}
            aspect="portrait"
            text="SAMPLE"
            style={{ height: 86, width: "100%", borderRadius: 6 }}
          />
          <span className="text-xs font-medium truncate w-full text-center">{s.name}</span>
        </button>
      ))}
    </div>
  );
}

function CombinedPreview({
  captionStyle,
  hookStyle,
  aspect,
}: {
  captionStyle: CaptionStyle | null;
  hookStyle: CaptionStyle | null;
  aspect: CaptionPreviewAspect;
}) {
  return (
    <div className="flex flex-col items-center gap-2 w-full">
      <p className="text-xs text-muted-foreground font-medium">Preview</p>
      <div
        className="relative w-full overflow-hidden rounded-xl border border-slate-700"
        style={{
          aspectRatio: aspect === "landscape" ? "16/9" : aspect === "square" ? "1/1" : "9/16",
        }}
      >
        {captionStyle ? (
          <CaptionTemplatePreview
            template={captionStyle}
            aspect={aspect}
            text="CAPTION TEXT"
            style={{ position: "absolute", inset: 0, height: "100%", width: "100%", borderRadius: 0 }}
          />
        ) : (
          <div className="absolute inset-0 bg-slate-800 flex items-center justify-center">
            <span className="text-slate-500 text-xs">no caption</span>
          </div>
        )}
        {hookStyle && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <CaptionTemplatePreview
              template={hookStyle}
              aspect={aspect}
              text="HOOK TEXT HERE"
              style={{ height: "100%", width: "100%", background: "transparent" }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function AutoBulkEditPage() {
  const router = useRouter();
  const [config, setConfig] = useState<AutoBulkEditConfig>(DEFAULT_CONFIG);
  const [captionStyles, setCaptionStyles] = useState<CaptionStyle[]>([]);
  const [hookStyles, setHookStyles] = useState<CaptionStyle[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [hookCustomInput, setHookCustomInput] = useState("8");
  const savedConfig = useRef<AutoBulkEditConfig | null>(null);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const pendingNavRef = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [configRes, stylesRes] = await Promise.all([
          axios.get(`${API_URL}/clips/settings/auto-bulk-edit`),
          axios.get(`${API_URL}/clips/captions/styles`),
        ]);
        const loaded: AutoBulkEditConfig = configRes.data.config;
        const cs: CaptionStyle[] = stylesRes.data.captionStyles || [];
        const hs: CaptionStyle[] = stylesRes.data.hookStyles || [];
        setCaptionStyles(cs);
        setHookStyles(hs);
        const resolved: AutoBulkEditConfig = {
          ...loaded,
          captions: { ...loaded.captions, styleId: loaded.captions.styleId || cs[0]?.id || null },
          hook:     { ...loaded.hook,     styleId: loaded.hook.styleId     || hs[0]?.id || null },
        };
        setConfig(resolved);
        savedConfig.current = resolved;
        const to = loaded.hook.timeoutSeconds;
        if (to !== null && to !== undefined && ![5, 10, 15].includes(to)) {
          setHookCustomInput(String(to));
        }
      } catch (err) {
        setError(getErrorMessage(err, "Failed to load settings."));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const isDirty = savedConfig.current !== null &&
    JSON.stringify(config) !== JSON.stringify(savedConfig.current);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const requestNavigation = useCallback((url: string) => {
    pendingNavRef.current = url;
    setDiscardDialogOpen(true);
  }, []);

  useEffect(() => {
    if (!isDirty) return;
    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as Element).closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("http") || href.startsWith("//") || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      requestNavigation(href);
    };
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [isDirty, requestNavigation]);

  const discardAndNavigate = () => {
    const dest = pendingNavRef.current;
    setDiscardDialogOpen(false);
    pendingNavRef.current = null;
    if (dest) router.push(dest);
  };

  const updateReframe  = (u: Partial<AutoBulkEditConfig["reframe"]>)  => setConfig(c => ({ ...c, reframe:  { ...c.reframe,  ...u } }));
  const updateCaptions = (u: Partial<AutoBulkEditConfig["captions"]>) => setConfig(c => ({ ...c, captions: { ...c.captions, ...u } }));
  const updateHook     = (u: Partial<AutoBulkEditConfig["hook"]>)     => setConfig(c => ({ ...c, hook:     { ...c.hook,     ...u } }));

  const handlePlatformChange = (id: string) => {
    updateReframe({ platform: id, reframeStyleId: id !== "tiktok" ? "fullscreen" : config.reframe.reframeStyleId });
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      const res = await axios.put(`${API_URL}/clips/settings/auto-bulk-edit`, config);
      const saved: AutoBulkEditConfig = res.data.config;
      setConfig(saved);
      savedConfig.current = saved;
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save settings."));
    } finally {
      setSaving(false);
    }
  };

  const selectedCaption  = captionStyles.find(s => s.id === config.captions.styleId) || null;
  const selectedHook     = hookStyles.find(s => s.id === config.hook.styleId) || null;
  const selectedPlatform = PLATFORMS.find(p => p.id === config.reframe.platform)!;
  const previewAspect: CaptionPreviewAspect = config.reframe.enabled
    ? (selectedPlatform?.previewAspect ?? "portrait")
    : "portrait";

  const hookTimeout = config.hook.timeoutSeconds;
  const isCustomTimeout = hookTimeout !== null && hookTimeout !== undefined && ![5, 10, 15].includes(hookTimeout);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-0">

      {/* Header with save button */}
      <div className="flex items-start justify-between gap-4 px-1 pb-5">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Zap className="h-6 w-6 text-primary" />
            Auto Bulk Edit
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            When enabled, every new transcript automatically renders all clips — no manual bulk edit needed.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-1">
          {isDirty && (
            <span className="text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-2 py-1 rounded-md">
              Unsaved changes
            </span>
          )}
          {success && !isDirty && (
            <span className="text-xs text-green-600 dark:text-green-400">Saved</span>
          )}
          <Button onClick={handleSave} disabled={saving || !isDirty}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Master toggle */}
      <div className="mb-5">
        <SectionHeader
          title="Enable Auto Bulk Edit"
          enabled={config.enabled}
          onToggle={() => setConfig(c => ({ ...c, enabled: !c.enabled }))}
        />
      </div>

      {/* Two-column layout matching BulkEditModal */}
      <div className={`flex flex-1 overflow-hidden min-h-0 rounded-xl border transition-opacity ${config.enabled ? "opacity-100" : "opacity-40 pointer-events-none"}`}>

        {/* Left: scrollable sections */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6 min-w-0">

          {/* Reframe */}
          <div className="space-y-3">
            <SectionHeader title="Reframe" enabled={config.reframe.enabled} onToggle={() => updateReframe({ enabled: !config.reframe.enabled })} />
            {config.reframe.enabled && (
              <div className="space-y-3 pl-1">
                <div className="grid grid-cols-3 gap-2">
                  {PLATFORMS.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handlePlatformChange(p.id)}
                      className={`flex flex-col items-center gap-2 rounded-lg border-2 py-3 px-2 text-xs font-medium transition-colors ${
                        config.reframe.platform === p.id ? "border-primary bg-primary/5" : "border-muted hover:border-muted-foreground/40"
                      }`}
                    >
                      {p.icon}
                      <span>{p.name}</span>
                      <span className="text-muted-foreground">{p.aspectRatio}</span>
                    </button>
                  ))}
                </div>
                {config.reframe.platform === "tiktok" && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Style</p>
                    <ReframeStylePicker value={config.reframe.reframeStyleId} onChange={id => updateReframe({ reframeStyleId: id })} />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Captions */}
          <div className="space-y-3">
            <SectionHeader title="Caption Style" enabled={config.captions.enabled} onToggle={() => updateCaptions({ enabled: !config.captions.enabled })} />
            {config.captions.enabled && (
              <div className="pl-1 space-y-2">
                <StyleGrid
                  styles={captionStyles}
                  value={config.captions.styleId || ""}
                  onChange={id => updateCaptions({ styleId: id })}
                />
                {selectedCaption?.description && (
                  <p className="text-xs text-muted-foreground">{selectedCaption.description}</p>
                )}
              </div>
            )}
          </div>

          {/* Hook */}
          <div className="space-y-3">
            <SectionHeader title="Hook Style" enabled={config.hook.enabled} onToggle={() => updateHook({ enabled: !config.hook.enabled })} />
            {config.hook.enabled && (
              <div className="pl-1 space-y-2">
                <p className="text-xs text-muted-foreground">Uses each clip&apos;s saved hook text.</p>
                <StyleGrid
                  styles={hookStyles}
                  value={config.hook.styleId || ""}
                  onChange={id => updateHook({ styleId: id })}
                />
                {selectedHook?.description && (
                  <p className="text-xs text-muted-foreground">{selectedHook.description}</p>
                )}
                <div className="pt-1 space-y-1.5">
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-300">Hook display duration</p>
                  <div className="flex flex-wrap gap-1.5">
                    {([null, 5, 10, 15] as (number | null)[]).map(val => (
                      <button
                        key={val ?? "off"}
                        type="button"
                        onClick={() => updateHook({ timeoutSeconds: val })}
                        className={`rounded-md px-3 py-1 text-xs font-medium border transition-colors ${
                          hookTimeout === val && !isCustomTimeout
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted hover:border-muted-foreground/50 bg-background"
                        }`}
                      >
                        {val === null ? "Full clip" : `${val}s`}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const v = parseFloat(hookCustomInput);
                        updateHook({ timeoutSeconds: Number.isFinite(v) && v > 0 ? v : null });
                      }}
                      className={`rounded-md px-3 py-1 text-xs font-medium border transition-colors ${
                        isCustomTimeout
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted hover:border-muted-foreground/50 bg-background"
                      }`}
                    >
                      Custom
                    </button>
                    {isCustomTimeout && (
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={0.5}
                          step={0.5}
                          value={hookCustomInput}
                          onChange={e => {
                            setHookCustomInput(e.target.value);
                            const v = parseFloat(e.target.value);
                            if (Number.isFinite(v) && v > 0) updateHook({ timeoutSeconds: v });
                          }}
                          className="w-16 rounded border border-input bg-background px-2 py-1 text-xs"
                        />
                        <span className="text-xs text-muted-foreground">sec</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: combined preview (matches BulkEditModal right panel) */}
        <div className="w-52 flex-shrink-0 border-l p-5 flex flex-col items-center gap-4 bg-muted/20 overflow-y-auto">
          <CombinedPreview
            captionStyle={config.captions.enabled ? selectedCaption : null}
            hookStyle={config.hook.enabled ? selectedHook : null}
            aspect={previewAspect}
          />
          <div className="text-xs text-muted-foreground text-center space-y-1 w-full">
            {config.reframe.enabled && (
              <div className="truncate">Reframe: <span className="font-medium">{selectedPlatform?.name}</span></div>
            )}
            {config.reframe.enabled && config.reframe.platform === "tiktok" && (
              <div className="truncate">Style: <span className="font-medium capitalize">{config.reframe.reframeStyleId}</span></div>
            )}
            {config.captions.enabled && (
              <div className="truncate">Captions: <span className="font-medium">{selectedCaption?.name || "—"}</span></div>
            )}
            {config.hook.enabled && (
              <div className="truncate">
                Hook: <span className="font-medium">{selectedHook?.name || "—"}</span>
                {hookTimeout !== null && <span className="text-muted-foreground"> · {hookTimeout}s</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
        <DialogContent className="rounded-3xl border-muted-foreground/10">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              You have unsaved changes to your auto bulk-edit settings. If you leave now, those changes will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setDiscardDialogOpen(false)} className="rounded-xl">
              Keep Editing
            </Button>
            <Button variant="destructive" onClick={discardAndNavigate} className="rounded-xl shadow-lg shadow-destructive/20">
              Discard Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
